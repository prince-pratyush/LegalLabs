-- Hardening for notifications and memory (follow-up to 0080-0084).
--   1. enqueue_email takes its subject, text and excerpt from the notification row, so a caller
--      can no longer send its own words to someone else's inbox.
--   2. notification.url holds only in-app paths and notification.actions only a short list of
--      id / label / style buttons; notify.emit checks both before it writes.
--   3. notify.emit skips a recipient who cannot open the object (thread, run, vault, table,
--      playbook), judged as that recipient.
--   4. memory.message_use rows can only be written for a message in the caller's own thread.
--   5. A workspace admin (admin.config) may edit a shared writing style, never a memory.
--   6. The test-only p_now argument is gone; the timing rule lives in notify.email_due, which
--      tests call directly.

-- In-app paths only: "/x" or "#/x", never "//host", "/\host", a scheme, or whitespace.
create function notify.is_app_path(p_url text) returns boolean
language sql immutable as $$
  select p_url is not null and char_length(p_url) between 1 and 500
     and p_url ~ '^(#/|/(?![/\\]))[^\s\\]*$'
$$;
grant execute on function notify.is_app_path(text) to legallabs_app, legallabs_definer;

-- At most five buttons, each with an id, a label and one of three styles, and nothing else.
create function notify.valid_actions(p_actions jsonb) returns boolean
language plpgsql immutable as $$
declare
  a jsonb;
begin
  if p_actions is null or jsonb_typeof(p_actions) <> 'array'
     or jsonb_array_length(p_actions) > 5 or octet_length(p_actions::text) > 2000 then
    return false;
  end if;
  for a in select e from jsonb_array_elements(p_actions) e loop
    if jsonb_typeof(a) <> 'object'
       or exists (select 1 from jsonb_object_keys(a) k where k not in ('id', 'label', 'style'))
       or jsonb_typeof(a -> 'id') is distinct from 'string'
       or jsonb_typeof(a -> 'label') is distinct from 'string'
       or jsonb_typeof(a -> 'style') is distinct from 'string'
       or char_length(a ->> 'id') not between 1 and 40
       or char_length(a ->> 'label') not between 1 and 60
       or (a ->> 'style') not in ('primary', 'secondary', 'danger') then
      return false;
    end if;
  end loop;
  return true;
end
$$;
grant execute on function notify.valid_actions(jsonb) to legallabs_app, legallabs_definer;

-- Rows made before this check came through emit's callers, which only sent app links; any
-- that don't fit are pointed home. The table forces RLS even on its owner, so the owner steps
-- out of it for the clean-up only.
alter table notify.notification no force row level security;
update notify.notification set url = '#/' where not notify.is_app_path(url);
update notify.notification set actions = '[]' where not notify.valid_actions(actions);
alter table notify.notification force row level security;
alter table notify.notification
  add constraint notification_url_app_path check (notify.is_app_path(url)) not valid,
  add constraint notification_actions_valid check (notify.valid_actions(actions)) not valid;
alter table notify.notification validate constraint notification_url_app_path;
alter table notify.notification validate constraint notification_actions_valid;

-- Whether `p_user` can open an object, as that person would see it: the same rules as the
-- tables' own read policies, worked out with the settings swapped to the recipient for the
-- length of the call. Types without a rule here are not blocked.
grant select (matter_id) on work.review_table to legallabs_definer;

create function notify.can_see(p_user uuid, p_type text, p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  was text := coalesce(pg_catalog.current_setting('app.user_id', true), '');
  ok boolean;
begin
  perform pg_catalog.set_config('app.user_id', p_user::text, true);
  ok := case p_type
    when 'thread' then exists (
      select 1 from work.thread t
       where t.id = p_id and t.workspace_id = core.current_workspace_id()
         and (t.owner_id = p_user or core.has_access('thread', t.id, 'view'))
         and core.can_access_matter(t.matter_id))
    when 'run' then exists (
      select 1 from work.run r join work.thread t on t.id = r.thread_id
       where r.id = p_id and r.workspace_id = core.current_workspace_id()
         and (t.owner_id = p_user or core.has_access('thread', t.id, 'view'))
         and core.can_access_matter(t.matter_id))
    when 'vault' then exists (
      select 1 from content.vault v
       where v.id = p_id and v.workspace_id = core.current_workspace_id()
         and core.can_access_matter(v.matter_id)
         and (content.vault_level(v.id) is not null
              or core.has_permission('admin.config')))
    when 'table' then exists (
      select 1 from work.review_table b
       where b.id = p_id and b.workspace_id = core.current_workspace_id()
         and b.owner_id = p_user and b.deleted_at is null
         and core.can_access_matter(b.matter_id))
    when 'playbook' then work.playbook_level(p_id) is not null
    else true
  end;
  perform pg_catalog.set_config('app.user_id', was, true);
  return coalesce(ok, false);
end
$$;
alter function notify.can_see(uuid, text, uuid) owner to legallabs_definer;
revoke execute on function notify.can_see(uuid, text, uuid) from public;
grant execute on function notify.can_see(uuid, text, uuid) to legallabs_definer;

/*
 * Same contract as before, plus: the link must be an in-app path, the actions a valid short
 * list, and a recipient who cannot open the object gets no row.
 */
create or replace function notify.emit(
  p_kind text, p_category text, p_object_type text, p_object_id uuid,
  p_title text, p_body text, p_actor uuid, p_action_required boolean,
  p_actions jsonb, p_url text, p_matter uuid, p_recipients uuid[]
) returns table (user_id uuid, notification_id uuid, count integer, merged boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  ws uuid := core.current_workspace_id();
  me uuid := core.current_user_id();
  r uuid;
  hit uuid;
  n integer;
begin
  if ws is null or not core.in_tenant(ws) then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  if p_actor is not null and p_actor is distinct from me then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  if not notify.is_app_path(p_url) then
    raise exception 'INVALID_URL' using errcode = 'check_violation';
  end if;
  if not notify.valid_actions(coalesce(p_actions, '[]'::jsonb)) then
    raise exception 'INVALID_ACTIONS' using errcode = 'check_violation';
  end if;
  for r in
    select distinct u.id from core."user" u
     where u.id = any (coalesce(p_recipients, '{}'))
       and u.workspace_id = ws and u.status = 'active'
       and u.id is distinct from p_actor
     order by u.id
  loop
    if p_matter is not null and not core.user_can_access_matter(r, p_matter) then
      continue;
    end if;
    if not notify.can_see(r, p_object_type, p_object_id) then
      continue;
    end if;
    perform pg_advisory_xact_lock(hashtextextended(r::text || p_kind || p_object_id::text, 0));
    select x.id into hit from notify.notification x
     where x.user_id = r and x.kind = p_kind and x.object_id = p_object_id
       and x.read_at is null and x.archived_at is null
       and x.created_at > now() - interval '10 minutes'
     order by x.created_at desc limit 1;
    if hit is not null then
      update notify.notification x
         set count = x.count + 1, title = p_title, body = p_body, actor_id = p_actor,
             created_at = now(), updated_at = now(), available = true,
             unavailable_since = null
       where x.id = hit
      returning x.count into n;
      user_id := r; notification_id := hit; count := n; merged := true;
    else
      insert into notify.notification (workspace_id, user_id, kind, category, object_type,
        object_id, title, body, actor_id, action_required, actions, url, matter_id)
      values (ws, r, p_kind, p_category, p_object_type, p_object_id, p_title, p_body, p_actor,
        p_action_required, coalesce(p_actions, '[]'), p_url, p_matter)
      returning id into hit;
      user_id := r; notification_id := hit; count := 1; merged := false;
    end if;
    return next;
  end loop;
end
$$;

-- When a queued email goes out. Action-required mail is due now. The rest waits for the next
-- 15-minute window, then until quiet hours end if the window falls inside them. Pure, so
-- tests give it any clock instead of the function that queues mail taking one.
create function notify.email_due(
  p_now timestamptz, p_action_required boolean, p_tz text, p_from time, p_to time
) returns timestamptz
language plpgsql stable as $$
declare
  window_end timestamptz;
  local_ts timestamp;
  local_t time;
  in_quiet boolean;
  end_local timestamp;
begin
  if p_action_required then
    return p_now;
  end if;
  window_end := date_bin('15 minutes', p_now, timestamptz '2000-01-01 00:00:00+00')
                + interval '15 minutes';
  if p_tz is null then
    return window_end;
  end if;
  local_ts := p_now at time zone p_tz;
  local_t := local_ts::time;
  in_quiet := case when p_from <= p_to
                   then local_t >= p_from and local_t < p_to
                   else local_t >= p_from or local_t < p_to end;
  if not in_quiet then
    return window_end;
  end if;
  end_local := local_ts::date + p_to;
  if end_local <= local_ts then end_local := end_local + interval '1 day'; end if;
  return greatest(window_end, end_local at time zone p_tz);
end
$$;
grant execute on function notify.email_due(timestamptz, boolean, text, time, time)
  to legallabs_app, legallabs_definer;

/*
 * Queues emails for notifications that notify.emit just made, with the same toggle, mode and
 * timing rules as before. What the mail says is read from the notification itself (title for
 * subject and text, body for the excerpt), never passed in, and only notifications the caller
 * made (as actor, or as a system event) can be queued. Returns how many were queued.
 */
drop function notify.enqueue_email(uuid[], text, text, text, boolean, boolean, timestamptz);
create function notify.enqueue_email(
  p_notification_ids uuid[], p_long_running boolean, p_completion boolean
) returns integer
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  ws uuid := core.current_workspace_id();
  me uuid := core.current_user_id();
  now_ timestamptz := now();
  include boolean;
  n record;
  is_locked boolean;
  dflt boolean;
  mine boolean;
  pmode text;
  effective boolean;
  q record;
  due timestamptz;
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
    select x.id, x.user_id, x.category, x.action_required, x.url, x.actor_id, x.kind,
           x.title, x.body
      from notify.notification x
      join core."user" u on u.id = x.user_id and u.workspace_id = x.workspace_id
     where x.id = any (coalesce(p_notification_ids, '{}'))
       and x.workspace_id = ws and u.status = 'active'
       and x.category <> 'memory'
       and (x.actor_id is null or x.actor_id = me)
       and x.created_at > now_ - interval '5 minutes'
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

    q := null;
    select h.from_local, h.to_local, h.tz into q
      from notify.notification_quiet_hours h where h.user_id = n.user_id;
    due := notify.email_due(now_, n.action_required, q.tz, q.from_local, q.to_local);

    select coalesce(nullif(a.name, ''), a.email) into actor_name
      from core."user" a where a.id = n.actor_id;
    insert into notify.email_outbox (workspace_id, user_id, category, batch_key, payload,
        scheduled_at, notification_id)
    values (ws, n.user_id, n.category,
      case when n.action_required then 'now:' || n.id::text
           else n.user_id::text || ':' || extract(epoch from due)::bigint::text end,
      jsonb_strip_nulls(jsonb_build_object(
        'kind', n.kind,
        'subject', left(n.title, 200),
        'text', left(n.title, 300),
        'url', n.url,
        'actor', actor_name,
        'action_required', n.action_required,
        'excerpt', case when include and n.body is not null then left(n.body, 300) end)),
      due, n.id)
    on conflict (notification_id) do nothing;
    get diagnostics got = row_count;
    queued := queued + got;
  end loop;
  return queued;
end
$$;
alter function notify.enqueue_email(uuid[], boolean, boolean) owner to legallabs_definer;
revoke execute on function notify.enqueue_email(uuid[], boolean, boolean) from public;
grant execute on function notify.enqueue_email(uuid[], boolean, boolean) to legallabs_app;

-- A message_use row can only be written for a message in the caller's own thread, so nobody
-- can plant provenance on, or probe, someone else's conversation.
drop policy message_use_own on memory.message_use;
create policy message_use_read on memory.message_use for select to legallabs_app
  using (user_id = core.current_user_id() and core.in_tenant(workspace_id));
create policy message_use_delete on memory.message_use for delete to legallabs_app
  using (user_id = core.current_user_id() and core.in_tenant(workspace_id));
create policy message_use_insert on memory.message_use for insert to legallabs_app
  with check (user_id = core.current_user_id() and core.in_tenant(workspace_id)
              and exists (select 1 from work.message m join work.thread t on t.id = m.thread_id
                           where m.id = message_id and t.owner_id = core.current_user_id()));
create policy message_use_update on memory.message_use for update to legallabs_app
  using (user_id = core.current_user_id() and core.in_tenant(workspace_id))
  with check (user_id = core.current_user_id() and core.in_tenant(workspace_id)
              and exists (select 1 from work.message m join work.thread t on t.id = m.thread_id
                           where m.id = message_id and t.owner_id = core.current_user_id()));

-- A workspace admin may edit a style that is shared with the workspace (the owner's own
-- edits work as before). Memories keep their own-user-only policies.
drop policy style_update on memory.writing_style;
create policy style_update on memory.writing_style for update to legallabs_app
  using (core.in_tenant(workspace_id) and memory.is_member()
         and (owner_id = core.current_user_id()
              or (shared and core.has_permission('admin.config'))))
  with check (core.in_tenant(workspace_id)
              and (not shared
                   or core.has_permission('writing_styles.share')
                   or (owner_id <> core.current_user_id()
                       and core.has_permission('admin.config'))));
