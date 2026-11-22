-- Agent, workflow and builder runs (agents-workflows.md §4.4, §4.5, §6). They are runs like a
-- thread turn, so they share the table and the event log; a Temporal workflow drives them.
alter table work.run
  add column subject_id uuid,
  add column agent_version_id uuid,
  add column workflow_version_id uuid,
  add column task_id uuid,
  add column space_id uuid,
  add column matter_id uuid,
  add column test_mode boolean not null default false,
  add column interactive boolean not null default true,
  add column paused boolean not null default false,
  add column finished_at timestamptz,
  add column error_code text check (char_length(error_code) <= 100),
  add column path text check (path in ('page', 'mention', 'word', 'task', 'schedule')),
  -- The id of the Temporal workflow, which is run:{id}; kept so a signal needs no lookup.
  add column engine_id text check (char_length(engine_id) <= 200),
  drop constraint run_kind_check,
  add constraint run_kind_check check (kind in ('thread', 'deep_analysis', 'playbook_review',
    'rt_column', 'agent', 'workflow', 'agent_builder')),
  add constraint run_agent_subject check (
    (kind in ('agent', 'workflow', 'agent_builder')) = (subject_id is not null));
create index run_subject_idx on work.run (workspace_id, kind, subject_id, created_at desc)
  where subject_id is not null;
create index run_owner_idx on work.run (owner_id, created_at desc);

-- Steps already log playbook reviews; agent and workflow runs add their own columns.
-- Prompt and answer text live in object storage; these rows hold the shape.
alter table work.run_step
  drop constraint run_step_status_check,
  add constraint run_step_status_check check (status in ('pending', 'running', 'awaiting_user',
    'done', 'failed', 'skipped', 'cancelled')),
  add column parent_step_id uuid,
  add column block_id text check (char_length(block_id) <= 60),
  add column label text check (char_length(label) <= 100),
  add column routing_class text check (char_length(routing_class) <= 40),
  add column input jsonb not null default '{}' check (jsonb_typeof(input) = 'object'),
  add column output jsonb not null default '{}' check (jsonb_typeof(output) = 'object'),
  -- Retries of the same step find the same result instead of paying twice.
  add column idempotency_key text check (char_length(idempotency_key) <= 100),
  add column error jsonb,
  add unique (run_id, id),
  add foreign key (run_id, parent_step_id) references work.run_step (run_id, id);
create index run_step_idempotency_idx on work.run_step (run_id, idempotency_key)
  where idempotency_key is not null;

grant update (status, model, routing_class, usage, cost_usd, finished_at, input, output,
              input_ref, output_ref, error) on work.run_step to legallabs_app;
grant update (finished_at, error_code, paused, plan, engine_id) on work.run to legallabs_app;
create policy run_step_update on work.run_step for update to legallabs_app
  using (core.in_tenant(workspace_id) and exists (
    select 1 from work.run r where r.id = run_id and r.owner_id = core.current_user_id()))
  with check (core.in_tenant(workspace_id));

-- The thread policies were written when every run was a thread turn; they now leave agent
-- kinds to the policies below, which ask for agents.use instead.
drop policy run_insert on work.run;
create policy run_insert on work.run for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and kind not in ('playbook_review', 'agent', 'workflow', 'agent_builder')
              and owner_id = core.current_user_id()
              and core.has_permission('threads.use')
              and exists (select 1 from work.thread t
                           where t.id = thread_id and t.owner_id = core.current_user_id()));
drop policy run_update on work.run;
create policy run_update on work.run for update to legallabs_app
  using (core.in_tenant(workspace_id) and owner_id = core.current_user_id()
         and kind not in ('playbook_review', 'agent', 'workflow', 'agent_builder')
         and core.has_permission('threads.use')
         and exists (select 1 from work.thread t where t.id = thread_id))
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id());
drop policy run_event_insert on work.run_event;
create policy run_event_insert on work.run_event for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and core.has_permission('threads.use') and exists (
    select 1 from work.run r where r.id = run_id and r.owner_id = core.current_user_id()
      and r.kind not in ('playbook_review', 'agent', 'workflow', 'agent_builder')));

-- Agent runs: driven by their owner, who needs agents.use; their thread is the owner's.
create policy run_insert_agent on work.run for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and kind in ('agent', 'workflow', 'agent_builder')
              and owner_id = core.current_user_id()
              and core.has_permission('agents.use')
              and exists (select 1 from work.thread t
                           where t.id = thread_id and t.owner_id = core.current_user_id()));
create policy run_update_agent on work.run for update to legallabs_app
  using (core.in_tenant(workspace_id)
         and kind in ('agent', 'workflow', 'agent_builder')
         and owner_id = core.current_user_id() and core.has_permission('agents.use'))
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id());
create policy run_event_insert_agent on work.run_event for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and core.has_permission('agents.use') and exists (
    select 1 from work.run r
     where r.id = run_id and r.owner_id = core.current_user_id()
       and r.kind in ('agent', 'workflow', 'agent_builder')));

-- The API process owns thread runs only; agent runs live in Temporal and resume on a worker.
create or replace function work.fail_orphaned_runs(started_before timestamptz) returns integer
language sql security definer set search_path = '' as $$
  with failed as (
    update work.run set status = 'failed', updated_at = now()
     where status in ('planned', 'running', 'verifying')
       and kind in ('thread', 'deep_analysis', 'playbook_review', 'rt_column')
       and updated_at < fail_orphaned_runs.started_before
    returning 1)
  select count(*)::int from failed
$$;
