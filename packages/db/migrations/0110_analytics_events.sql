-- Command Center event store. Features record one usage event per query or counted action and
-- one outcome event per completed piece of work. Nothing here holds prompt text, file names or
-- citation quotes: ids, counts and labels only. The charts never read these tables directly;
-- they read analytics.daily, which the materialiser (0111) fills every six hours.
create schema analytics;
revoke all on schema analytics from public;
grant usage on schema analytics to legallabs_app, legallabs_definer, legallabs_worker;
grant create on schema analytics to legallabs_definer;
alter default privileges in schema analytics revoke execute on functions from public;

create table analytics.usage_event (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  at timestamptz not null default now(),
  user_id uuid,
  access_point text not null
    check (access_point in ('web', 'word', 'outlook', 'mobile', 'api', 'email')),
  surface text not null check (surface in
    ('web', 'word', 'outlook', 'review_tables', 'agents', 'apps', 'email', 'api', 'mobile')),
  subsurface text check (char_length(subsurface) <= 80),
  action text not null check (action ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),
  action_class text not null check (action_class in ('query', 'other')),
  -- Which per-user column of "Users by activity" this event counts toward, if any.
  counter text check (counter in
    ('threads', 'follow_ups', 'agent_runs', 'playbook_runs', 'rt_columns', 'word', 'outlook')),
  object_type text check (char_length(object_type) <= 80),
  object_id text check (char_length(object_id) <= 256),
  matter_ref text check (char_length(matter_ref) <= 256),
  source_kinds text[] not null default '{}',
  document_count integer not null default 0 check (document_count >= 0),
  model text check (char_length(model) <= 120),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  cost_usd numeric(12, 6) check (cost_usd >= 0),
  duration_ms integer check (duration_ms >= 0),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id)
);
create index usage_event_at_idx on analytics.usage_event (workspace_id, at);
create index usage_event_user_idx on analytics.usage_event (workspace_id, user_id, at);

create table analytics.outcome_baseline (
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  workflow_type text not null check (workflow_type in (
    'contract_reviewed', 'redline_applied', 'table_exported', 'draft_exported',
    'research_memo_completed', 'request_resolved', 'chronology_generated',
    'translation_completed', 'proofread_applied')),
  hours_per_completion numeric(8, 2) not null check (hours_per_completion between 0 and 1000),
  note text not null default '' check (char_length(note) <= 500),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, workflow_type)
);

-- The baseline in force at the time is kept on the event, so editing a baseline never
-- rewrites history.
create table analytics.outcome_event (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  at timestamptz not null default now(),
  user_id uuid,
  workflow_type text not null,
  quantity integer not null default 1 check (quantity >= 1),
  turnaround_seconds integer check (turnaround_seconds >= 0),
  baseline_hours numeric(8, 2) not null,
  hours_saved numeric(10, 2) not null check (hours_saved >= 0),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id)
);
create index outcome_event_at_idx on analytics.outcome_event (workspace_id, at);

create table analytics.daily (
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  day date not null,
  metrics jsonb not null,
  materialised_at timestamptz not null default now(),
  primary key (workspace_id, day)
);

create table analytics.refresh_state (
  workspace_id uuid primary key references core.workspace (id) on delete cascade,
  materialised_at timestamptz,
  requested_at timestamptz
);

create table analytics.action_dismissal (
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  user_id uuid not null,
  action_key text not null check (char_length(action_key) between 1 and 80),
  dismissed_until timestamptz not null,
  primary key (user_id, action_key),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);

create table analytics.export_job (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  requested_by uuid not null,
  params jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  row_count integer,
  storage_key text,
  bytes bigint,
  gzip boolean not null default false,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  -- Seven days after the file is ready.
  expires_at timestamptz,
  foreign key (workspace_id, requested_by) references core."user" (workspace_id, id)
);
create index export_job_ws_idx on analytics.export_job (workspace_id, created_at desc);

alter table analytics.usage_event owner to legallabs_definer;
alter table analytics.outcome_baseline owner to legallabs_definer;
alter table analytics.outcome_event owner to legallabs_definer;
alter table analytics.daily owner to legallabs_definer;
alter table analytics.refresh_state owner to legallabs_definer;
alter table analytics.action_dismissal owner to legallabs_definer;
alter table analytics.export_job owner to legallabs_definer;

alter table analytics.usage_event enable row level security;
alter table analytics.usage_event force row level security;
alter table analytics.outcome_baseline enable row level security;
alter table analytics.outcome_baseline force row level security;
alter table analytics.outcome_event enable row level security;
alter table analytics.outcome_event force row level security;
alter table analytics.daily enable row level security;
alter table analytics.daily force row level security;
alter table analytics.refresh_state enable row level security;
alter table analytics.refresh_state force row level security;
alter table analytics.action_dismissal enable row level security;
alter table analytics.action_dismissal force row level security;
alter table analytics.export_job enable row level security;
alter table analytics.export_job force row level security;

-- Reads are for people who hold admin.reporting. Writes go through the functions below.
grant select on analytics.usage_event, analytics.outcome_event, analytics.daily,
  analytics.refresh_state, analytics.outcome_baseline, analytics.export_job to legallabs_app;
create policy usage_event_read on analytics.usage_event for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.reporting'));
create policy outcome_event_read on analytics.outcome_event for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.reporting'));
create policy daily_read on analytics.daily for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.reporting'));
create policy refresh_state_read on analytics.refresh_state for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.reporting'));
create policy outcome_baseline_read on analytics.outcome_baseline for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.reporting'));
create policy export_job_read on analytics.export_job for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.reporting'));

grant select, insert, update, delete on analytics.action_dismissal to legallabs_app;
create policy dismissal_own on analytics.action_dismissal for all to legallabs_app
  using (core.in_tenant(workspace_id) and user_id = core.current_user_id()
         and core.has_permission('admin.reporting'))
  with check (core.in_tenant(workspace_id) and user_id = core.current_user_id()
              and core.has_permission('admin.reporting'));

-- The definer owns the tables; FORCE row security would otherwise hide every row from it.
create policy definer_all on analytics.usage_event for all to legallabs_definer
  using (true) with check (true);
create policy definer_all on analytics.outcome_event for all to legallabs_definer
  using (true) with check (true);
create policy definer_all on analytics.outcome_baseline for all to legallabs_definer
  using (true) with check (true);
create policy definer_all on analytics.daily for all to legallabs_definer
  using (true) with check (true);
create policy definer_all on analytics.refresh_state for all to legallabs_definer
  using (true) with check (true);
create policy definer_all on analytics.export_job for all to legallabs_definer
  using (true) with check (true);
create policy definer_all on analytics.action_dismissal for all to legallabs_definer
  using (true) with check (true);
grant select, insert, update, delete on all tables in schema analytics to legallabs_definer;

-- Features call these as the signed-in person. The caller is always the recorded user, and the
-- event lands in the caller's own workspace, so nobody can write another person's activity.
create function analytics.record_usage(
  p_surface text,
  p_action text,
  p_action_class text,
  p_counter text default null,
  p_access_point text default 'web',
  p_subsurface text default null,
  p_object_type text default null,
  p_object_id text default null,
  p_matter_ref text default null,
  p_source_kinds text[] default '{}',
  p_document_count integer default 0,
  p_model text default null,
  p_input_tokens integer default null,
  p_output_tokens integer default null,
  p_cost_usd numeric default null,
  p_duration_ms integer default null,
  p_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  me uuid := core.current_user_id();
  new_id uuid;
begin
  if me is null or ws is null or not core.in_tenant(ws) then
    raise exception 'usage needs a signed-in member' using errcode = '42501';
  end if;
  insert into analytics.usage_event (workspace_id, at, user_id, access_point, surface, subsurface,
    action, action_class, counter, object_type, object_id, matter_ref, source_kinds,
    document_count, model, input_tokens, output_tokens, cost_usd, duration_ms)
  values (ws, coalesce(p_at, now()), me, p_access_point, p_surface, p_subsurface, p_action,
    p_action_class, p_counter, p_object_type, p_object_id, p_matter_ref,
    coalesce(p_source_kinds, '{}'), coalesce(p_document_count, 0), p_model, p_input_tokens,
    p_output_tokens, p_cost_usd, p_duration_ms)
  returning id into new_id;
  return new_id;
end
$$;

-- hours saved = baseline x quantity; a review table is 0.1 hours a row, at most 40 hours.
create function analytics.record_outcome(
  p_workflow_type text,
  p_quantity integer default 1,
  p_turnaround_seconds integer default null,
  p_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  me uuid := core.current_user_id();
  base numeric;
  saved numeric;
  new_id uuid;
begin
  if me is null or ws is null or not core.in_tenant(ws) then
    raise exception 'outcome needs a signed-in member' using errcode = '42501';
  end if;
  select b.hours_per_completion into base
    from analytics.outcome_baseline b
   where b.workspace_id = ws and b.workflow_type = p_workflow_type;
  if base is null then
    base := case p_workflow_type
      when 'contract_reviewed' then 2.0
      when 'redline_applied' then 1.0
      when 'table_exported' then 0.1
      when 'draft_exported' then 1.5
      when 'research_memo_completed' then 4.0
      when 'request_resolved' then 0.5
      when 'chronology_generated' then 6.0
      when 'translation_completed' then 1.0
      when 'proofread_applied' then 0.5
    end;
  end if;
  if base is null then
    raise exception 'unknown workflow type' using errcode = '22023';
  end if;
  saved := case when p_workflow_type = 'table_exported'
                then least(base * greatest(p_quantity, 1), 40)
                else base end;
  insert into analytics.outcome_event (workspace_id, at, user_id, workflow_type, quantity,
    turnaround_seconds, baseline_hours, hours_saved)
  values (ws, coalesce(p_at, now()), me, p_workflow_type, greatest(p_quantity, 1),
    p_turnaround_seconds, base, saved)
  returning id into new_id;
  return new_id;
end
$$;

-- Admins with admin.config set a baseline; it applies from now on.
create function analytics.set_baseline(p_workflow_type text, p_hours numeric, p_note text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
begin
  if not core.has_permission('admin.config') then
    raise exception 'only an admin can change baselines' using errcode = '42501';
  end if;
  insert into analytics.outcome_baseline (workspace_id, workflow_type, hours_per_completion, note)
  values (ws, p_workflow_type, p_hours, coalesce(p_note, ''))
  on conflict (workspace_id, workflow_type)
  do update set hours_per_completion = excluded.hours_per_completion, note = excluded.note,
                updated_at = now();
end
$$;

alter function analytics.record_usage(text, text, text, text, text, text, text, text, text,
  text[], integer, text, integer, integer, numeric, integer, timestamptz)
  owner to legallabs_definer;
alter function analytics.record_outcome(text, integer, integer, timestamptz)
  owner to legallabs_definer;
alter function analytics.set_baseline(text, numeric, text) owner to legallabs_definer;
grant execute on function
  analytics.record_usage(text, text, text, text, text, text, text, text, text, text[], integer,
    text, integer, integer, numeric, integer, timestamptz),
  analytics.record_outcome(text, integer, integer, timestamptz),
  analytics.set_baseline(text, numeric, text)
  to legallabs_app;
