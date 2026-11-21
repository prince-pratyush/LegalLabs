-- Agents (agents-workflows.md §4.1, §4.5, §4.6, §6). An agent is a title and two pointers; what
-- it does lives in immutable versions. Sharing lives in core.share_grant (ADR-028).

-- Run sits below view for agents: it executes the live version without reading it.
create or replace function core.level_rank(level text) returns integer
language sql immutable as $$
  select case level when 'run' then 1 when 'view' then 2 when 'edit' then 3 when 'full' then 4 end
$$;

create table work.agent (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  owner_id uuid not null,
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  practice_areas text[] not null default '{}' check (cardinality(practice_areas) <= 10),
  auto_description boolean not null default true,
  -- What Run access executes, and what an editor is working on. Both are version ids.
  live_version_id uuid,
  draft_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  unique (workspace_id, id),
  check ((deleted_at is null) = (deleted_by is null)),
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id),
  foreign key (workspace_id, deleted_by) references core."user" (workspace_id, id)
);
create index agent_owner_idx on work.agent (workspace_id, owner_id) where deleted_at is null;

create table work.agent_version (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  agent_id uuid not null,
  no integer not null check (no >= 1),
  instructions text not null check (char_length(instructions) <= 20000),
  attachments jsonb not null default '[]' check (jsonb_typeof(attachments) = 'array'
                                                 and jsonb_array_length(attachments) <= 50),
  sources jsonb not null default '[]' check (jsonb_typeof(sources) = 'array'
                                             and jsonb_array_length(sources) <= 5),
  -- Title, description and practice areas as of this version.
  details jsonb not null default '{}' check (jsonb_typeof(details) = 'object'),
  -- For nudges: lexical always, meaning when the install has an embedder.
  tsv tsvector generated always as (to_tsvector('english',
    coalesce(details ->> 'title', '') || ' ' || coalesce(details ->> 'description', ''))) stored,
  title_desc_embedding vector(1024),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (agent_id, no),
  unique (agent_id, id),
  unique (workspace_id, id),
  foreign key (workspace_id, agent_id) references work.agent (workspace_id, id) on delete cascade,
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id)
);
create index agent_version_tsv_idx on work.agent_version using gin (tsv);

alter table work.agent
  add foreign key (id, live_version_id) references work.agent_version (agent_id, id)
    deferrable initially deferred,
  add foreign key (id, draft_version_id) references work.agent_version (agent_id, id)
    deferrable initially deferred;

-- Files an agent carries. Stored as documents owned by the agent's creator; this link lets
-- anyone who may run the agent read them without a grant on the document.
create table work.agent_document (
  workspace_id uuid not null,
  agent_id uuid not null,
  document_id uuid not null,
  primary key (agent_id, document_id),
  foreign key (workspace_id, agent_id) references work.agent (workspace_id, id) on delete cascade,
  foreign key (workspace_id, document_id) references content.document (workspace_id, id)
    on delete cascade
);

-- What the caller may do with an agent, or null. Owners hold full; shares count only with the
-- matching permission, so taking agents.use or agents.build away always cuts access.
create function work.agent_level(p_agent uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when a.owner_id = core.current_user_id() and core.has_permission('agents.use') then 'full'
    when core.has_access('agent', a.id, 'full') and core.has_permission('agents.build') then 'full'
    when core.has_access('agent', a.id, 'edit') and core.has_permission('agents.build') then 'edit'
    when core.has_access('agent', a.id, 'view') and core.has_permission('agents.use') then 'view'
    when core.has_access('agent', a.id, 'run') and core.has_permission('agents.use') then 'run'
  end
  from work.agent a
 where a.id = p_agent
   and a.workspace_id = core.current_workspace_id()
   and a.deleted_at is null
   and core.is_active_member()
$$;
alter function work.agent_level(uuid) owner to legallabs_definer;
revoke execute on function work.agent_level(uuid) from public;
grant execute on function work.agent_level(uuid) to legallabs_app, legallabs_definer;

alter table work.agent enable row level security;
alter table work.agent force row level security;
alter table work.agent_version enable row level security;
alter table work.agent_version force row level security;
alter table work.agent_document enable row level security;
alter table work.agent_document force row level security;

grant select, insert on work.agent, work.agent_version, work.agent_document to legallabs_app;
grant update (title, description, practice_areas, auto_description, live_version_id,
              draft_version_id, updated_at) on work.agent
  to legallabs_app;
grant delete on work.agent_document to legallabs_app;

create policy agent_read on work.agent for select to legallabs_app
  using (core.in_tenant(workspace_id) and deleted_at is null and work.agent_level(id) is not null);
-- A plain column test, so a new row can be returned by the insert that made it: a function
-- reading the table would not see it yet.
create policy agent_owner_read on work.agent for select to legallabs_app
  using (core.in_tenant(workspace_id) and deleted_at is null
         and owner_id = core.current_user_id());
-- Admins see every agent's title and owner for reporting; versions stay with those who run it.
create policy agent_admin_read on work.agent for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('agents.admin'));
create policy agent_insert on work.agent for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id()
              and core.has_permission('agents.build') and deleted_at is null);
create policy agent_update on work.agent for update to legallabs_app
  using (core.in_tenant(workspace_id) and work.agent_level(id) in ('edit', 'full'))
  with check (core.in_tenant(workspace_id) and deleted_at is null);

create policy agent_version_read on work.agent_version for select to legallabs_app
  using (core.in_tenant(workspace_id) and work.agent_level(agent_id) in ('view', 'edit', 'full'));
create policy agent_version_insert on work.agent_version for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and created_by = core.current_user_id()
              and work.agent_level(agent_id) in ('edit', 'full'));

create policy agent_document_read on work.agent_document for select to legallabs_app
  using (core.in_tenant(workspace_id) and work.agent_level(agent_id) is not null);
create policy agent_document_write on work.agent_document for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and work.agent_level(agent_id) in ('edit', 'full'));
create policy agent_document_delete on work.agent_document for delete to legallabs_app
  using (core.in_tenant(workspace_id) and work.agent_level(agent_id) in ('edit', 'full'));

-- Policy functions run as the definer, which needs to see the rows they look at.
grant select on work.agent_version, work.agent_document to legallabs_definer;
create policy definer_read on work.agent_version for select to legallabs_definer using (true);
create policy definer_read on work.agent_document for select to legallabs_definer using (true);

-- Anyone who may run an agent may read its uploads; the document's own wall still applies.
create function work.agent_upload_readable(p_document uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from work.agent_document d
                  where d.document_id = p_document and work.agent_level(d.agent_id) is not null)
$$;
alter function work.agent_upload_readable(uuid) owner to legallabs_definer;
grant execute on function work.agent_upload_readable(uuid) to legallabs_app;
create policy document_agent_upload_read on content.document for select to legallabs_app
  using (core.in_tenant(workspace_id) and deleted_at is null and matter_id is null
         and work.agent_upload_readable(id));

-- A run reads the version it was started on. Run access is enough for the live version, but
-- the instructions are never shown to the person, only used by the run.
create function work.agent_version_for_run(p_agent uuid, p_version uuid)
returns table (id uuid, no integer, instructions text, attachments jsonb, sources jsonb,
               details jsonb, is_live boolean)
language sql stable security definer set search_path = '' as $$
  select v.id, v.no, v.instructions, v.attachments, v.sources, v.details,
         (a.live_version_id = v.id)
    from work.agent a join work.agent_version v on v.agent_id = a.id
   where a.id = p_agent and v.id = p_version
     and work.agent_level(a.id) is not null
     and (a.live_version_id = v.id or work.agent_level(a.id) in ('view', 'edit', 'full'))
$$;
alter function work.agent_version_for_run(uuid, uuid) owner to legallabs_definer;
grant execute on function work.agent_version_for_run(uuid, uuid) to legallabs_app;

-- Schedules: one per agent per user (§3.6).
create table work.agent_schedule (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  agent_id uuid not null,
  user_id uuid not null,
  rule text not null check (rule in ('every_n_days', 'weekly')),
  params jsonb not null default '{}' check (jsonb_typeof(params) = 'object'),
  time_local text not null check (time_local ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  tz text not null check (char_length(tz) <= 64),
  matter_id uuid,
  email boolean not null default false,
  anchor_date date,
  status text not null default 'active' check (status in ('active', 'paused')),
  paused_reason text check (char_length(paused_reason) <= 200),
  next_run_at timestamptz,
  last_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, user_id),
  unique (workspace_id, id),
  foreign key (workspace_id, agent_id) references work.agent (workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade,
  foreign key (workspace_id, matter_id) references core.matter (workspace_id, id)
);
create index agent_schedule_next_idx on work.agent_schedule (next_run_at) where status = 'active';
alter table work.agent_schedule enable row level security;
alter table work.agent_schedule force row level security;
grant select, insert, delete on work.agent_schedule to legallabs_app;
grant update (rule, params, time_local, tz, matter_id, email, anchor_date, status, paused_reason,
              next_run_at, last_run_id, updated_at) on work.agent_schedule to legallabs_app;
create policy schedule_own on work.agent_schedule for all to legallabs_app
  using (core.in_tenant(workspace_id) and user_id = core.current_user_id())
  with check (core.in_tenant(workspace_id) and user_id = core.current_user_id()
              and work.agent_level(agent_id) is not null
              and (select a.live_version_id is not null from work.agent a where a.id = agent_id));

-- Deleting an agent pauses every schedule on it, whoever made them.
create function work.pause_agent_schedules() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update work.agent_schedule
       set status = 'paused', paused_reason = 'agent_deleted', updated_at = now()
     where agent_id = new.id and status = 'active';
  end if;
  return new;
end
$$;
alter function work.pause_agent_schedules() owner to legallabs_definer;
grant update (status, paused_reason, updated_at) on work.agent_schedule to legallabs_definer;
grant select on work.agent_schedule to legallabs_definer;
create policy definer_pause on work.agent_schedule for all to legallabs_definer
  using (true) with check (true);
create trigger agent_pause_schedules after update of deleted_at on work.agent
  for each row execute function work.pause_agent_schedules();

-- A fire has no person: the worker reads the schedule by id, then acts as its owner.
create function work.agent_schedule_for_fire(p_id uuid)
returns table (id uuid, workspace_id uuid, agent_id uuid, user_id uuid, rule text, params jsonb,
               time_local text, tz text, matter_id uuid, email boolean, anchor_date date,
               status text, live_version_id uuid)
language sql stable security definer set search_path = '' as $$
  select s.id, s.workspace_id, s.agent_id, s.user_id, s.rule, s.params, s.time_local, s.tz,
         s.matter_id, s.email, s.anchor_date, s.status, a.live_version_id
    from work.agent_schedule s join work.agent a on a.id = s.agent_id
   where s.id = p_id and a.deleted_at is null
$$;
alter function work.agent_schedule_for_fire(uuid) owner to legallabs_definer;
revoke execute on function work.agent_schedule_for_fire(uuid) from public;
grant execute on function work.agent_schedule_for_fire(uuid) to legallabs_worker;
grant select on work.agent to legallabs_definer;
create policy definer_read on work.agent for select to legallabs_definer using (true);

-- Share requests (§3.7). A grant needing approval waits here until someone decides.
create table work.share_request (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  resource_type text not null check (resource_type in ('agent', 'workflow')),
  resource_id uuid not null,
  principal_type text not null check (principal_type in ('user', 'group', 'space', 'workspace')),
  principal_id uuid not null,
  level text not null check (level in ('run', 'view', 'edit', 'full')),
  approver text not null check (approver in ('agents_admin', 'space_admin')),
  requested_by uuid not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'denied')),
  decided_by uuid,
  decided_at timestamptz,
  reason text check (char_length(reason) <= 500),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, requested_by) references core."user" (workspace_id, id),
  foreign key (workspace_id, decided_by) references core."user" (workspace_id, id),
  check ((status = 'pending') = (decided_by is null))
);
create index share_request_queue_idx on work.share_request (workspace_id, status, created_at);
create unique index share_request_one_pending on work.share_request
  (resource_type, resource_id, principal_type, principal_id) where status = 'pending';
alter table work.share_request enable row level security;
alter table work.share_request force row level security;
grant select, insert on work.share_request to legallabs_app;
create policy share_request_read on work.share_request for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (requested_by = core.current_user_id()
              or (approver = 'agents_admin' and core.has_permission('agents.admin'))));
create policy share_request_insert on work.share_request for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and requested_by = core.current_user_id()
              and status = 'pending'
              and case resource_type
                    when 'agent' then work.agent_level(resource_id) = 'full'
                    else false end);

-- Accepting writes the grant the requester could not. Only the approver the matrix named may
-- decide, and only a workspace admin can for now: Space admins arrive with Spaces.
create function work.decide_share_request(p_id uuid, p_accept boolean, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  r work.share_request%rowtype;
begin
  select * into r from work.share_request
   where id = p_id and workspace_id = core.current_workspace_id() and status = 'pending'
   for update;
  if not found then return 'NOT_FOUND'; end if;
  if r.approver <> 'agents_admin' or not core.has_permission('agents.admin') then
    return 'FORBIDDEN';
  end if;
  if p_accept then
    insert into core.share_grant (workspace_id, object_type, object_id, principal_type,
                                  principal_id, level, granted_by)
    values (r.workspace_id, r.resource_type, r.resource_id, r.principal_type, r.principal_id,
            r.level, r.requested_by)
    on conflict (object_type, object_id, principal_type, principal_id)
      do update set level = excluded.level;
  end if;
  update work.share_request
     set status = case when p_accept then 'accepted' else 'denied' end,
         decided_by = core.current_user_id(), decided_at = now(), reason = p_reason
   where id = p_id;
  return 'OK';
end
$$;
alter function work.decide_share_request(uuid, boolean, text) owner to legallabs_definer;
grant select, update on work.share_request to legallabs_definer;
grant insert, update on core.share_grant to legallabs_definer;
create policy definer_decide on work.share_request for all to legallabs_definer
  using (true) with check (true);
create policy definer_grant on core.share_grant for all to legallabs_definer
  using (true) with check (true);
revoke execute on function work.decide_share_request(uuid, boolean, text) from public;
grant execute on function work.decide_share_request(uuid, boolean, text) to legallabs_app;

-- Which shares wait for approval (admin switches under Configurations → Sharing).
create table work.sharing_config (
  workspace_id uuid primary key references core.workspace (id) on delete cascade,
  require_individual boolean not null default false,
  require_group boolean not null default false,
  require_workspace boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table work.sharing_config enable row level security;
alter table work.sharing_config force row level security;
grant select, insert, update on work.sharing_config to legallabs_app;
create policy sharing_config_read on work.sharing_config for select to legallabs_app
  using (core.in_tenant(workspace_id));
create policy sharing_config_write on work.sharing_config for all to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.config'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));

-- A dismissed nudge stays quiet for that person for 30 days (§4.2).
create table work.agent_nudge_dismissal (
  workspace_id uuid not null,
  user_id uuid not null,
  agent_id uuid not null,
  dismissed_at timestamptz not null default now(),
  primary key (user_id, agent_id),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_id) references work.agent (workspace_id, id) on delete cascade
);
alter table work.agent_nudge_dismissal enable row level security;
alter table work.agent_nudge_dismissal force row level security;
grant select, insert, update, delete on work.agent_nudge_dismissal to legallabs_app;
create policy nudge_own on work.agent_nudge_dismissal for all to legallabs_app
  using (core.in_tenant(workspace_id) and user_id = core.current_user_id())
  with check (core.in_tenant(workspace_id) and user_id = core.current_user_id());

grant execute on all functions in schema work to legallabs_definer;
