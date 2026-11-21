-- Email: queueing (called right after notify.emit) and the worker's claim / mark functions.
-- Everything runs as legallabs_definer; the worker role holds no grant on any table.
alter table notify.email_outbox add column notification_id uuid;
create unique index email_outbox_notification_idx on notify.email_outbox (notification_id);

/*
 * Queues emails for notifications that notify.emit just made. Each recipient's effective
 * toggle is `locked ? workspace value : (own value ?? workspace default)`. Email goes out for
 * action-required events, for completions of long runs in "action only" mode, and for
 * everything when the person chose "all". Action-required mail is due now; the rest waits for
 * the next 15-minute window, or for the end of the person's quiet hours if they are in them.
 * The subject and text come from the catalogue (no prompt, response or memory text); the
 * comment excerpt is kept only when the workspace allows content, cut to 300 characters.
 * Returns how many emails were queued. `p_now` is for tests.
 */
create function notify.enqueue_email(
  p_notification_ids uuid[], p_subject text, p_text text, p_content text,
  p_long_running boolean, p_completion boolean, p_now timestamptz default null
) returns integer
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  ws uuid := core.current_workspace_id();
  now_ timestamptz := coalesce(p_now, now());
  include boolean;
  n record;
  is_locked boolean;
  dflt boolean;
  mine boolean;
  pmode text;
  effective boolean;
  q record;
  local_ts timestamp;
  local_t time;
  in_quiet boolean;
  end_local timestamp;
  due timestamptz;
  window_end timestamptz;
  actor_name text;
  queued integer := 0;
  got integer;
begin
  if ws is null or not core.in_tenant(ws) then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  select coalesce((select s.include_content from notify.workspace_notification_setting s
                    where s.workspace_id = ws), false) into include;
  for n in
    select x.id, x.user_id, x.category, x.action_required, x.url, x.actor_id, x.kind
      from notify.notification x
      join core."user" u on u.id = x.user_id and u.workspace_id = x.workspace_id
     where x.id = any (coalesce(p_notification_ids, '{}'))
       and x.workspace_id = ws and u.status = 'active'
       and x.category <> 'memory'
       and x.created_at > now() - interval '5 minutes'
  loop
    is_locked := null; dflt := null; mine := null; pmode := null;
    select w.locked, w.default_value into is_locked, dflt
      from notify.workspace_notification_pref w
     where w.workspace_id = ws and w.category = n.category;
    is_locked := coalesce(is_locked, false);
    dflt := coalesce(dflt, true);
    select p.value, p.mode into mine, pmode
      from notify.notification_pref p where p.user_id = n.user_id and p.category = n.category;
    pmode := coalesce(pmode, 'action_only');
    effective := case when is_locked then dflt else coalesce(mine, dflt) end;
    if not effective then continue; end if;
    if not (n.action_required or pmode = 'all'
            or (p_completion and p_long_running and pmode = 'action_only')) then
      continue;
    end if;

    if n.action_required then
      due := now_;
    else
      -- The next 15-minute window, then pushed to the end of quiet hours if inside them.
      window_end := date_bin('15 minutes', now_, timestamptz '2000-01-01 00:00:00+00')
                    + interval '15 minutes';
      due := window_end;
      select h.from_local, h.to_local, h.tz into q
        from notify.notification_quiet_hours h where h.user_id = n.user_id;
      if found then
        local_ts := now_ at time zone q.tz;
        local_t := local_ts::time;
        in_quiet := case when q.from_local <= q.to_local
                         then local_t >= q.from_local and local_t < q.to_local
                         else local_t >= q.from_local or local_t < q.to_local end;
        if in_quiet then
          end_local := local_ts::date + q.to_local;
          if end_local <= local_ts then end_local := end_local + interval '1 day'; end if;
          due := greatest(window_end, end_local at time zone q.tz);
        end if;
      end if;
    end if;

    select coalesce(nullif(a.name, ''), a.email) into actor_name
      from core."user" a where a.id = n.actor_id;
    insert into notify.email_outbox (workspace_id, user_id, category, batch_key, payload,
        scheduled_at, notification_id)
    values (ws, n.user_id, n.category,
      case when n.action_required then 'now:' || n.id::text
           else n.user_id::text || ':' || extract(epoch from due)::bigint::text end,
      jsonb_strip_nulls(jsonb_build_object(
        'kind', n.kind,
        'subject', left(p_subject, 200),
        'text', left(p_text, 300),
        'url', n.url,
        'actor', actor_name,
        'action_required', n.action_required,
        'excerpt', case when include and p_content is not null
                        then left(p_content, 300) end)),
      due, n.id)
    on conflict (notification_id) do nothing;
    get diagnostics got = row_count;
    queued := queued + got;
  end loop;
  return queued;
end
$$;
alter function notify.enqueue_email(uuid[], text, text, text, boolean, boolean, timestamptz)
  owner to legallabs_definer;
revoke execute on function notify.enqueue_email(uuid[], text, text, text, boolean, boolean, timestamptz)
  from public;
grant execute on function notify.enqueue_email(uuid[], text, text, text, boolean, boolean, timestamptz)
  to legallabs_app;

/*
 * Takes due emails for the worker. A claimed row is leased for ten minutes (so a crashed
 * worker's mail is retried) and counts one attempt; rows past five attempts are left alone.
 */
create function notify.claim_email(p_now timestamptz default now(), p_limit integer default 200)
returns table (
  id uuid, user_id uuid, workspace_id uuid, category text, batch_key text, payload jsonb,
  attempts integer, to_email text, to_name text
)
language sql security definer set search_path = '' as $$
  with due as (
    select o.id from notify.email_outbox o
      join core."user" u on u.id = o.user_id and u.workspace_id = o.workspace_id
     where o.sent_at is null and o.scheduled_at <= p_now and o.attempts < 5
       and u.status = 'active'
     order by o.scheduled_at, o.id
     limit greatest(p_limit, 1)
       for update of o skip locked
  ), claimed as (
    update notify.email_outbox o
       set attempts = o.attempts + 1, scheduled_at = p_now + interval '10 minutes'
      from due where o.id = due.id
    returning o.id, o.user_id, o.workspace_id, o.category, o.batch_key, o.payload, o.attempts
  )
  select c.id, c.user_id, c.workspace_id, c.category, c.batch_key, c.payload, c.attempts,
         u.email::text, u.name::text
    from claimed c join core."user" u on u.id = c.user_id
   order by c.batch_key, c.id
$$;
alter function notify.claim_email(timestamptz, integer) owner to legallabs_definer;
revoke execute on function notify.claim_email(timestamptz, integer) from public;
grant execute on function notify.claim_email(timestamptz, integer) to legallabs_worker;

create function notify.mark_email_sent(p_ids uuid[], p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update notify.email_outbox o set sent_at = p_now, error = null
   where o.id = any (p_ids) and o.sent_at is null;
  get diagnostics n = row_count;
  update notify.notification x set email_sent_at = p_now
   where x.id in (select o.notification_id from notify.email_outbox o where o.id = any (p_ids));
  return n;
end
$$;
alter function notify.mark_email_sent(uuid[], timestamptz) owner to legallabs_definer;
revoke execute on function notify.mark_email_sent(uuid[], timestamptz) from public;
grant execute on function notify.mark_email_sent(uuid[], timestamptz) to legallabs_worker;

-- Failed sends retry after 5 minutes per attempt so far.
create function notify.mark_email_error(p_ids uuid[], p_error text, p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update notify.email_outbox o
     set error = left(p_error, 500), scheduled_at = p_now + o.attempts * interval '5 minutes'
   where o.id = any (p_ids) and o.sent_at is null;
  get diagnostics n = row_count;
  return n;
end
$$;
alter function notify.mark_email_error(uuid[], text, timestamptz) owner to legallabs_definer;
revoke execute on function notify.mark_email_error(uuid[], text, timestamptz) from public;
grant execute on function notify.mark_email_error(uuid[], text, timestamptz) to legallabs_worker;
