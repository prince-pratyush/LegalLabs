-- Intake: requests from people who have no account, triaged by staff. A service user per
-- workspace owns their files in an Inbox vault, which triage staff read by permission rather
-- than by share, so it follows roles as they change.

create table apps.intake_inbox (
  workspace_id uuid primary key references core.workspace (id) on delete cascade,
  service_user_id uuid not null,
  vault_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, service_user_id) references core."user" (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, vault_id) references content.vault (workspace_id, id)
    on delete cascade
);

create table apps.intake_request_type (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  description text not null default '' check (char_length(description) <= 1000),
  fields jsonb not null check (jsonb_typeof(fields) = 'array' and pg_column_size(fields) <= 200000),
  routing jsonb check (jsonb_typeof(routing) = 'object' and pg_column_size(routing) <= 100000),
  default_owners uuid[] not null default '{}' check (cardinality(default_owners) <= 50),
  reviewers uuid[] not null default '{}' check (cardinality(reviewers) <= 50),
  escalations jsonb not null default '[]'
    check (jsonb_typeof(escalations) = 'array' and pg_column_size(escalations) <= 100000),
  sla_hours integer not null check (sla_hours between 1 and 720),
  timeout_hours integer not null default 72 check (timeout_hours between 1 and 720),
  keyword_rules text[] not null default '{}' check (cardinality(keyword_rules) <= 50),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Soft, so a request made against it keeps its name.
  deleted_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id)
);
create unique index intake_request_type_name_idx
  on apps.intake_request_type (workspace_id, lower(name)) where deleted_at is null;

-- Someone outside the platform. Never a user: there is nothing here to sign in with.
create table apps.intake_requester (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  channel text not null check (channel in
    ('email', 'slack', 'teams', 'jira', 'servicenow', 'gmail', 'dms', 'api')),
  external_user_id text not null check (char_length(external_user_id) between 1 and 320),
  display_name text not null check (char_length(display_name) between 1 and 200),
  email text check (char_length(email) <= 320),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, channel, external_user_id)
);

create table apps.intake_counter (
  workspace_id uuid primary key references core.workspace (id) on delete cascade,
  last integer not null
);

create table apps.intake_request (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  -- Set by the trigger below, whatever the insert says.
  number integer not null,
  channel text not null check (channel in
    ('email', 'slack', 'teams', 'jira', 'servicenow', 'gmail', 'dms', 'api')),
  external_ref text not null check (char_length(external_ref) between 1 and 200),
  requester_id uuid not null,
  -- As given with this request, so one request never changes what another shows.
  requester_name text not null check (char_length(requester_name) between 1 and 200),
  requester_email text check (char_length(requester_email) <= 320),
  type_id uuid,
  fields jsonb not null default '{}'
    check (jsonb_typeof(fields) = 'object' and pg_column_size(fields) <= 200000),
  missing_fields text[] not null default '{}',
  status text not null check (status in ('new', 'unclassified', 'awaiting_requester',
    'triaged', 'in_progress', 'waiting_approval', 'done', 'closed')),
  closed_reason text check (char_length(closed_reason) <= 500),
  assignee_id uuid,
  matter_id uuid,
  sla_due_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, number),
  unique (workspace_id, channel, external_ref),
  check ((status = 'closed') = (closed_reason is not null)),
  foreign key (workspace_id, requester_id) references apps.intake_requester (workspace_id, id),
  foreign key (workspace_id, type_id) references apps.intake_request_type (workspace_id, id),
  foreign key (workspace_id, assignee_id) references core."user" (workspace_id, id),
  foreign key (workspace_id, matter_id) references core.matter (workspace_id, id),
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id)
);
create index intake_request_status_idx
  on apps.intake_request (workspace_id, status, created_at desc);
create index intake_request_assignee_idx on apps.intake_request (assignee_id, status);
create index intake_request_requester_idx on apps.intake_request (requester_id);

-- A file in the Inbox vault, and the request it belongs to once there is one.
create table apps.intake_attachment (
  document_id uuid primary key,
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  request_id uuid,
  added_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, document_id) references content.document (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, request_id) references apps.intake_request (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, added_by) references core."user" (workspace_id, id)
);
create index intake_attachment_request_idx on apps.intake_attachment (request_id);
create index intake_attachment_workspace_idx on apps.intake_attachment (workspace_id);

-- A request's timeline. Appended to, never edited.
create table apps.intake_event (
  id uuid primary key default core.uuid7(),
  -- Events written in one transaction share a time; this keeps their order.
  seq bigint generated always as identity,
  workspace_id uuid not null,
  request_id uuid not null,
  at timestamptz not null default now(),
  kind text not null check (kind in ('inbound', 'outbound', 'classified', 'routed', 'assigned',
    'status', 'escalated', 'sla', 'merged')),
  actor_type text not null check (actor_type in ('requester', 'user', 'system', 'agent')),
  actor_id uuid,
  details jsonb not null default '{}'
    check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 4000),
  foreign key (workspace_id, request_id) references apps.intake_request (workspace_id, id)
    on delete cascade
);
create index intake_event_request_idx on apps.intake_event (request_id, seq);

alter table apps.intake_inbox enable row level security;
alter table apps.intake_inbox force row level security;
alter table apps.intake_request_type enable row level security;
alter table apps.intake_request_type force row level security;
alter table apps.intake_requester enable row level security;
alter table apps.intake_requester force row level security;
alter table apps.intake_counter enable row level security;
alter table apps.intake_counter force row level security;
alter table apps.intake_request enable row level security;
alter table apps.intake_request force row level security;
alter table apps.intake_attachment enable row level security;
alter table apps.intake_attachment force row level security;
alter table apps.intake_event enable row level security;
alter table apps.intake_event force row level security;

grant select on apps.intake_inbox to legallabs_definer;
grant insert, update on apps.intake_inbox to legallabs_definer;
grant select, insert on apps.intake_requester to legallabs_definer;
grant select, insert, update on apps.intake_counter to legallabs_definer;
grant select on apps.intake_request, apps.intake_attachment to legallabs_definer;
create policy definer_all on apps.intake_inbox for all to legallabs_definer
  using (true) with check (true);
create policy definer_all on apps.intake_requester for all to legallabs_definer
  using (true) with check (true);
create policy definer_all on apps.intake_counter for all to legallabs_definer
  using (true) with check (true);
create policy definer_read on apps.intake_request for select to legallabs_definer using (true);
create policy definer_read on apps.intake_attachment for select to legallabs_definer
  using (true);

-- Staff are members: no guest or service account holds an intake permission.
create function apps.intake_may(p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select core.has_permission(p_permission)
     and exists (select 1 from core."user" u
                  where u.id = core.current_user_id()
                    and u.workspace_id = core.current_workspace_id() and u.kind = 'member')
$$;

create function apps.is_intake_vault(p_vault uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from apps.intake_inbox i
                  where i.vault_id = p_vault and i.workspace_id = core.current_workspace_id())
$$;

create function apps.is_intake_principal(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from apps.intake_inbox i
                  where i.service_user_id = p_user
                    and i.workspace_id = core.current_workspace_id())
$$;

-- The service user holds one permission, to read and file its own documents, and only because
-- it is the Inbox's: the role and permission columns of a service account stay empty.
create or replace function core.has_permission(permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select coalesce((permission = any (u.extra_permissions || r.permissions)
                     or '*' = any (r.permissions))
                    and u.kind <> 'guest'
                    -- Service accounts never hold admin permissions.
                    and (u.kind = 'member' or permission not like 'admin.%'), false)
           or (u.kind = 'service' and has_permission.permission = 'threads.use'
               and exists (select 1 from apps.intake_inbox i
                            where i.workspace_id = u.workspace_id and i.service_user_id = u.id))
      from core."user" u
      left join core.role r on r.workspace_id = u.workspace_id and r.id = u.role_id
     where u.id = core.current_user_id()
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active'), false)
$$;

-- As 0030, plus the Inbox for triage staff, to view only.
create or replace function content.readable_vaults(min_level text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(v.id), '{}')
    from content.vault v
   where v.workspace_id = core.current_workspace_id()
     and core.is_active_member()
     and content.is_member()
     and v.deleted_at is null
     and core.can_access_matter(v.matter_id)
     and (v.owner_id = core.current_user_id() or core.has_access('vault', v.id, min_level)
          or (min_level = 'view' and apps.is_intake_vault(v.id)
              and apps.intake_may('intake.triage')))
$$;

create or replace function content.vault_level(p_vault uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when v.owner_id = core.current_user_id() then 'owner'
    when core.has_access('vault', v.id, 'full') then 'full'
    when core.has_access('vault', v.id, 'edit') then 'edit'
    when core.has_access('vault', v.id, 'view') then 'view'
    when apps.is_intake_vault(v.id) and apps.intake_may('intake.triage') then 'view'
  end
    from content.vault v
   where v.id = p_vault
     and v.workspace_id = core.current_workspace_id()
     and core.is_active_member()
     and content.is_member()
     and v.deleted_at is null
     and core.can_access_matter(v.matter_id)
$$;

create policy vault_intake_read on content.vault for select to legallabs_app
  using (workspace_id = core.current_workspace_id() and deleted_at is null
         and apps.is_intake_vault(id) and apps.intake_may('intake.triage'));

-- As 0031, but the Inbox stays with its service user: a new owner could share what came in.
create or replace function content.transfer_vault(p_vault uuid, p_new_owner uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  previous uuid;
begin
  if not core.has_permission('admin.config') then
    raise exception 'only an admin can transfer a vault' using errcode = '42501';
  end if;
  select v.owner_id into previous from content.vault v
   where v.id = p_vault and v.workspace_id = ws and v.deleted_at is null
     and not apps.is_intake_vault(v.id) for update;
  if previous is null or not exists (
    select 1 from core."user" u
     where u.id = p_new_owner and u.workspace_id = ws and u.status = 'active'
       and u.kind = 'member') then
    return false;
  end if;
  if previous = p_new_owner then
    return true;
  end if;
  update content.vault set owner_id = p_new_owner, updated_at = now() where id = p_vault;
  delete from core.share_grant g
   where g.object_type = 'vault' and g.object_id = p_vault and g.principal_type = 'user'
     and g.principal_id in (previous, p_new_owner);
  insert into core.share_grant
    (workspace_id, object_type, object_id, principal_type, principal_id, level, granted_by)
  values (ws, 'vault', p_vault, 'user', previous, 'full', core.current_user_id());
  return true;
end
$$;

-- Nobody may turn the service account into one that can sign in or call the API.
create function apps.guard_intake_user() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'legallabs_app' and apps.is_intake_principal(old.id) then
    raise exception 'the intake service account cannot be changed' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger intake_user_guard before update on core."user"
  for each row execute function apps.guard_intake_user();

create function apps.guard_intake_token() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'legallabs_app' and apps.is_intake_principal(new.principal_id) then
    raise exception 'the intake service account takes no tokens' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger intake_token_guard before insert or update on core.api_token
  for each row execute function apps.guard_intake_token();

-- Makes the service user and Inbox vault the first time they are needed.
create function apps.ensure_intake_inbox()
returns table (service_user_id uuid, vault_id uuid)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  ws uuid := core.current_workspace_id();
  who uuid;
  room uuid;
begin
  if not (apps.intake_may('intake.triage') or apps.intake_may('intake.manage')) then
    raise exception 'not allowed to use intake' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('apps.intake_inbox ' || ws::text, 0));
  select i.service_user_id into who from apps.intake_inbox i where i.workspace_id = ws;
  select v.id into room from apps.intake_inbox i join content.vault v on v.id = i.vault_id
   where i.workspace_id = ws and v.deleted_at is null;
  if who is null or room is null then
    if who is null then
      -- A random address, so nobody can have taken it first.
      insert into core."user" (workspace_id, email, name, kind, status)
      values (ws, 'intake-' || pg_catalog.gen_random_uuid()::text || '@inbox.invalid',
              'Intake inbox', 'service', 'active')
      returning id into who;
    end if;
    insert into content.vault (workspace_id, owner_id, name, description, content_controls)
    values (ws, who, 'Intake inbox', 'Files sent in with intake requests.',
            '{"allow_download": true, "allow_duplicate": false, "show_review_prompts": true}')
    returning id into room;
    insert into apps.intake_inbox as i (workspace_id, service_user_id, vault_id)
    values (ws, who, room)
    on conflict (workspace_id) do update set vault_id = excluded.vault_id;
    perform admin.append_audit_event('intake.inbox.created', 'user', core.current_user_id(),
      'vault', room::text, pg_catalog.jsonb_build_object('service_user_id', who));
  end if;
  return query select who, room;
end
$$;
grant insert on content.vault to legallabs_definer;
create policy definer_insert on content.vault for insert to legallabs_definer with check (true);
create policy definer_service_insert on core."user" for insert to legallabs_definer
  with check (kind = 'service');

create function apps.intake_requester_id(p_channel text, p_external text, p_name text,
                                         p_email text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  found_id uuid;
begin
  if not apps.intake_may('intake.triage') then
    raise exception 'not allowed to use intake' using errcode = '42501';
  end if;
  insert into apps.intake_requester (workspace_id, channel, external_user_id, display_name, email)
  values (ws, p_channel, p_external, p_name, p_email)
  on conflict (workspace_id, channel, external_user_id) do nothing;
  select r.id into found_id from apps.intake_requester r
   where r.workspace_id = ws and r.channel = p_channel and r.external_user_id = p_external;
  return found_id;
end
$$;

create function apps.number_intake_request() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into apps.intake_counter as c (workspace_id, last) values (new.workspace_id, 1)
  on conflict (workspace_id) do update set last = c.last + 1
  returning c.last into new.number;
  return new;
end
$$;
create trigger intake_request_number before insert on apps.intake_request
  for each row execute function apps.number_intake_request();

-- Whether a request on this matter may be given to this person. Answers only to triage staff
-- about matters they can open, so it can't be used to read other people's walls.
create function apps.intake_can_take(p_user uuid, p_matter uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select apps.intake_may('intake.triage')
     and core.can_access_matter(p_matter)
     and exists (
       select 1 from core."user" u
         left join core.role r on r.workspace_id = u.workspace_id and r.id = u.role_id
        where u.id = p_user and u.workspace_id = core.current_workspace_id()
          and u.status = 'active' and u.kind = 'member'
          and (u.extra_permissions || coalesce(r.permissions, '{}'))
              && array['intake.triage', '*'])
     and core.user_can_access_matter(p_user, p_matter)
$$;

-- Inbox files the caller must not see although they can see the Inbox: a walled matter's, and
-- anything someone else has added but not yet attached. What a file unpacks into goes with it.
create function apps.intake_hidden_documents() returns uuid[]
language sql stable security definer set search_path = '' as $$
  with recursive hidden as (
    select a.document_id id
      from apps.intake_attachment a
      join apps.intake_inbox i on i.workspace_id = a.workspace_id
      left join apps.intake_request r on r.id = a.request_id
     where a.workspace_id = core.current_workspace_id()
       -- The service user reads its own files, for ingest.
       and core.current_user_id() is distinct from i.service_user_id
       and ((a.request_id is null and a.added_by is distinct from core.current_user_id())
            or (r.matter_id is not null
                and r.matter_id <> all ((select content.accessible_matters())::uuid[])))
    union
    select d.id from content.document d join hidden h on d.parent_id = h.id
     where d.workspace_id = core.current_workspace_id()
  )
  select coalesce(array_agg(id), '{}') from hidden
$$;
create policy document_intake_wall on content.document as restrictive for select to legallabs_app
  using (id <> all ((select apps.intake_hidden_documents())::uuid[]));

alter function apps.intake_may(text) owner to legallabs_definer;
alter function apps.is_intake_vault(uuid) owner to legallabs_definer;
alter function apps.is_intake_principal(uuid) owner to legallabs_definer;
alter function apps.ensure_intake_inbox() owner to legallabs_definer;
alter function apps.intake_requester_id(text, text, text, text) owner to legallabs_definer;
alter function apps.number_intake_request() owner to legallabs_definer;
alter function apps.intake_can_take(uuid, uuid) owner to legallabs_definer;
alter function apps.intake_hidden_documents() owner to legallabs_definer;
revoke execute on function apps.intake_may(text), apps.is_intake_vault(uuid),
  apps.is_intake_principal(uuid), apps.ensure_intake_inbox(),
  apps.intake_requester_id(text, text, text, text), apps.number_intake_request(),
  apps.intake_can_take(uuid, uuid), apps.intake_hidden_documents() from public;
grant execute on function apps.intake_may(text), apps.is_intake_vault(uuid),
  apps.is_intake_principal(uuid), apps.ensure_intake_inbox(),
  apps.intake_requester_id(text, text, text, text), apps.intake_can_take(uuid, uuid),
  apps.intake_hidden_documents() to legallabs_app;
grant execute on function apps.intake_may(text), apps.is_intake_vault(uuid) to legallabs_definer;

grant select on apps.intake_inbox to legallabs_app;
create policy intake_inbox_read on apps.intake_inbox for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (apps.intake_may('intake.triage') or apps.intake_may('intake.manage')));

grant select, insert on apps.intake_request_type to legallabs_app;
grant update (name, description, fields, routing, default_owners, reviewers, escalations,
              sla_hours, timeout_hours, keyword_rules, updated_at, deleted_at)
  on apps.intake_request_type to legallabs_app;
create policy intake_type_read on apps.intake_request_type for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (apps.intake_may('intake.triage') or apps.intake_may('intake.manage')
              or apps.intake_may('admin.config')));
create policy intake_type_insert on apps.intake_request_type for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and created_by = core.current_user_id()
              and deleted_at is null
              and (apps.intake_may('intake.manage') or apps.intake_may('admin.config')));
create policy intake_type_update on apps.intake_request_type for update to legallabs_app
  using (core.in_tenant(workspace_id) and deleted_at is null
         and (apps.intake_may('intake.manage') or apps.intake_may('admin.config')))
  with check (core.in_tenant(workspace_id));

-- A request is read by triage staff who can open its matter. Everything about it follows this.
grant select, insert on apps.intake_request to legallabs_app;
grant update (type_id, missing_fields, status, closed_reason, assignee_id, sla_due_at, updated_at)
  on apps.intake_request to legallabs_app;
create policy intake_request_read on apps.intake_request for select to legallabs_app
  using (core.in_tenant(workspace_id) and (select apps.intake_may('intake.triage'))
         and (matter_id is null
              or matter_id = any ((select content.accessible_matters())::uuid[])));
-- Manual and API requests only; a channel that receives its own adds its own way in.
create policy intake_request_insert on apps.intake_request for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and apps.intake_may('intake.triage')
              and core.can_access_matter(matter_id)
              and channel = 'api' and created_by = core.current_user_id()
              and status in ('new', 'unclassified')
              and num_nonnulls(assignee_id, closed_reason) = 0);
create policy intake_request_update on apps.intake_request for update to legallabs_app
  using (core.in_tenant(workspace_id) and apps.intake_may('intake.triage')
         and core.can_access_matter(matter_id))
  with check (core.in_tenant(workspace_id) and apps.intake_may('intake.triage')
              and core.can_access_matter(matter_id));

-- What policies can't say, because they can't see the old row.
create function apps.intake_request_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user <> 'legallabs_app' then
    return new;
  end if;
  if old.status in ('done', 'closed') then
    raise exception 'a finished request cannot change' using errcode = '42501';
  end if;
  if new.assignee_id is distinct from old.assignee_id and new.assignee_id is not null
     and not apps.intake_can_take(new.assignee_id, old.matter_id) then
    raise exception 'that assignee cannot take this request' using errcode = '42501';
  end if;
  return new;
end
$$;
grant execute on function apps.intake_request_guard() to legallabs_app;
create trigger intake_request_guard before update on apps.intake_request
  for each row execute function apps.intake_request_guard();

grant select on apps.intake_requester to legallabs_app;
create policy intake_requester_read on apps.intake_requester for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from apps.intake_request r
                      where r.requester_id = intake_requester.id));

grant select, insert on apps.intake_attachment to legallabs_app;
grant update (request_id) on apps.intake_attachment to legallabs_app;
create policy intake_attachment_read on apps.intake_attachment for select to legallabs_app
  using (core.in_tenant(workspace_id) and apps.intake_may('intake.triage')
         and case when request_id is null then added_by = core.current_user_id()
                  else exists (select 1 from apps.intake_request r where r.id = request_id) end);
-- Only the service user adds one, in the transaction that files the document, and names the
-- person it is for. So nobody can claim a file they did not send, and none is ever unclaimed.
create policy intake_attachment_insert on apps.intake_attachment for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and apps.is_intake_principal(core.current_user_id()) and request_id is null
              and exists (select 1 from core."user" u where u.id = added_by and u.kind = 'member')
              and exists (select 1 from content.document d
                           where d.id = document_id and d.parent_id is null
                             and d.matter_id is null and apps.is_intake_vault(d.vault_id)));
-- Attached once, by whoever added it, to a request they are making.
create policy intake_attachment_update on apps.intake_attachment for update to legallabs_app
  using (core.in_tenant(workspace_id) and apps.intake_may('intake.triage')
         and added_by = core.current_user_id() and request_id is null)
  with check (core.in_tenant(workspace_id) and added_by = core.current_user_id()
              and exists (select 1 from apps.intake_request r
                           where r.id = request_id and r.created_by = core.current_user_id()));

grant select, insert on apps.intake_event to legallabs_app;
create policy intake_event_read on apps.intake_event for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from apps.intake_request r where r.id = request_id));
create policy intake_event_insert on apps.intake_event for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and actor_type = 'user'
              and actor_id = core.current_user_id()
              and exists (select 1 from apps.intake_request r where r.id = request_id));

-- As 0230, with intake requests: only people who could open one are told about it.
create or replace function notify.can_see(p_user uuid, p_type text, p_id uuid) returns boolean
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
    when 'ci_review' then exists (
      select 1 from apps.ci_contract_review r
        join content.document d on d.id = r.document_id
       where r.id = p_id and r.workspace_id = core.current_workspace_id()
         and p_user in (r.owner_id, r.assignee_id, r.assigned_by)
         and d.deleted_at is null
         and core.can_access_matter(d.matter_id)
         and case when d.vault_id is null then d.owner_id = p_user
                  else content.vault_level(d.vault_id) is not null end)
    when 'intake_request' then exists (
      select 1 from apps.intake_request r
       where r.id = p_id and r.workspace_id = core.current_workspace_id()
         and apps.intake_may('intake.triage')
         and core.can_access_matter(r.matter_id))
    else true
  end;
  perform pg_catalog.set_config('app.user_id', was, true);
  return coalesce(ok, false);
end
$$;
