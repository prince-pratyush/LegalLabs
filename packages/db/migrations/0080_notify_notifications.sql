-- The notifications hub: one row per person per thing they should know about.
-- Fan-out goes through notify.emit, so the app role can read and tidy its own rows but
-- can never write a notification for someone else.
create schema notify;
grant usage on schema notify to legallabs_app, legallabs_definer, legallabs_worker;

create table notify.notification (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  user_id uuid not null,
  kind text not null check (char_length(kind) between 1 and 80),
  category text not null check (char_length(category) between 1 and 40),
  object_type text not null check (char_length(object_type) between 1 and 40),
  object_id uuid not null,
  title text not null check (char_length(title) between 1 and 300),
  body text check (char_length(body) <= 500),
  actor_id uuid,
  action_required boolean not null default false,
  actions jsonb not null default '[]',
  url text not null check (char_length(url) between 1 and 500),
  count integer not null default 1 check (count >= 1),
  available boolean not null default true,
  unavailable_since timestamptz,
  done_at timestamptz,
  matter_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  read_at timestamptz,
  archived_at timestamptz,
  email_sent_at timestamptz,
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);
create index notification_inbox_idx
  on notify.notification (user_id, archived_at, read_at, created_at desc);
create index notification_dedup_idx
  on notify.notification (user_id, kind, object_id, created_at);
create index notification_unavailable_idx
  on notify.notification (unavailable_since) where unavailable_since is not null;

alter table notify.notification enable row level security;
alter table notify.notification force row level security;

-- Own rows only: not even an admin reads someone else's inbox.
grant select on notify.notification to legallabs_app;
grant update (read_at, archived_at, available, unavailable_since, done_at)
  on notify.notification to legallabs_app;
create policy notification_read on notify.notification for select to legallabs_app
  using (user_id = core.current_user_id() and core.in_tenant(workspace_id));
create policy notification_update on notify.notification for update to legallabs_app
  using (user_id = core.current_user_id() and core.in_tenant(workspace_id))
  with check (user_id = core.current_user_id() and core.in_tenant(workspace_id));

grant select, insert, update, delete on notify.notification to legallabs_definer;
create policy definer_all on notify.notification for all to legallabs_definer
  using (true) with check (true);

/*
 * Notifies `p_recipients` of one event. The caller must be an active member of the
 * workspace, and may name itself as the actor or no actor (a system event), never someone
 * else. The actor never hears about their own action, recipients must be active users of
 * the workspace, and a matter's wall is checked now, for each recipient. The same kind on
 * the same object inside ten minutes merges into the newest unread notification.
 */
create function notify.emit(
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
alter function notify.emit(text, text, text, uuid, text, text, uuid, boolean, jsonb, text, uuid, uuid[])
  owner to legallabs_definer;
revoke execute on function notify.emit(text, text, text, uuid, text, text, uuid, boolean, jsonb, text, uuid, uuid[])
  from public;
grant execute on function notify.emit(text, text, text, uuid, text, text, uuid, boolean, jsonb, text, uuid, uuid[])
  to legallabs_app;

/*
 * Housekeeping for the worker: archive what has been unavailable for 7 days, delete unread
 * and unarchived items after 90 days and archived ones after 30. Returns what it did.
 */
create function notify.purge(p_now timestamptz default now())
returns table (archived integer, deleted integer)
language plpgsql security definer set search_path = '' as $$
declare
  a integer;
  d integer;
begin
  update notify.notification x set archived_at = p_now, updated_at = p_now
   where x.archived_at is null and x.unavailable_since is not null
     and x.unavailable_since < p_now - interval '7 days';
  get diagnostics a = row_count;
  delete from notify.notification x
   where (x.archived_at is null and x.created_at < p_now - interval '90 days')
      or (x.archived_at is not null and x.archived_at < p_now - interval '30 days');
  get diagnostics d = row_count;
  archived := a;
  deleted := d;
  return next;
end
$$;
alter function notify.purge(timestamptz) owner to legallabs_definer;
revoke execute on function notify.purge(timestamptz) from public;
grant execute on function notify.purge(timestamptz) to legallabs_worker;
