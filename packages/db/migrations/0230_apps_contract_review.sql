-- Contract review agents and the queue of contracts they review. A queued contract starts a
-- playbook review as the agent's owner; nothing here widens what that person can read.
create schema apps;
grant usage on schema apps to legallabs_app, legallabs_definer, legallabs_worker;

create table apps.ci_review_agent (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  owner_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  contract_type text not null check (char_length(contract_type) between 1 and 100),
  playbook_id uuid not null,
  party text not null check (char_length(party) between 1 and 200),
  paper text not null check (paper in ('ours', 'theirs')),
  assignment jsonb not null check (jsonb_typeof(assignment) = 'array'
                                   and pg_column_size(assignment) <= 100000),
  thresholds jsonb not null check (jsonb_typeof(thresholds) = 'object'),
  status text not null default 'draft' check (status in ('draft', 'live', 'paused')),
  -- Moves once per round-robin assignment, under the row's lock.
  round_robin_cursor integer not null default 0 check (round_robin_cursor >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id),
  foreign key (workspace_id, playbook_id) references work.playbook (workspace_id, id)
);
create index ci_review_agent_owner_idx on apps.ci_review_agent (owner_id, created_at desc);

create table apps.ci_contract_review (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  ci_agent_id uuid not null,
  -- Copies of the agent's, so the policies and the list never need the agent row.
  agent_name text not null check (char_length(agent_name) between 1 and 200),
  owner_id uuid not null,
  -- The one it was last reviewed against: who may be assigned depends on it.
  playbook_id uuid not null,
  document_id uuid not null,
  document_version_id uuid not null,
  playbook_review_id uuid,
  run_id uuid,
  status text not null default 'queued' check (status in ('queued', 'running', 'aligned',
    'needs_review', 'deviates', 'done', 'failed')),
  result text check (result in ('aligned', 'needs_review', 'deviates')),
  summary text check (char_length(summary) <= 1000),
  failure text check (char_length(failure) <= 40),
  assignee_id uuid,
  -- Whoever last handed it on keeps sight of it.
  assigned_by uuid,
  counterparty text check (char_length(counterparty) <= 200),
  fields jsonb not null default '{}' check (jsonb_typeof(fields) = 'object'),
  source jsonb not null default '{"kind": "manual"}' check (jsonb_typeof(source) = 'object'),
  -- When the queue next looks at it; pushed ahead while one worker holds it.
  next_attempt_at timestamptz not null default now(),
  started_at timestamptz,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, ci_agent_id) references apps.ci_review_agent (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id),
  foreign key (workspace_id, assignee_id) references core."user" (workspace_id, id),
  foreign key (workspace_id, assigned_by) references core."user" (workspace_id, id),
  foreign key (workspace_id, playbook_id) references work.playbook (workspace_id, id),
  -- A purged document takes its reviews with it.
  foreign key (workspace_id, document_version_id)
    references content.document_version (workspace_id, id) on delete cascade,
  foreign key (workspace_id, playbook_review_id)
    references work.playbook_review (workspace_id, id) on delete set null (playbook_review_id),
  foreign key (workspace_id, run_id) references work.run (workspace_id, id)
    on delete set null (run_id)
);
create index ci_contract_review_status_idx
  on apps.ci_contract_review (workspace_id, status, updated_at desc);
create index ci_contract_review_assignee_idx on apps.ci_contract_review (assignee_id, status);
create index ci_contract_review_agent_idx
  on apps.ci_contract_review (ci_agent_id, created_at desc);
create index ci_contract_review_document_idx on apps.ci_contract_review (document_id);
create index ci_contract_review_due_idx on apps.ci_contract_review (next_attempt_at)
  where status in ('queued', 'running');

alter table apps.ci_review_agent enable row level security;
alter table apps.ci_review_agent force row level security;
alter table apps.ci_contract_review enable row level security;
alter table apps.ci_contract_review force row level security;

-- An agent is its owner's; building one takes both permissions, now and at every change.
grant select, insert on apps.ci_review_agent to legallabs_app;
grant update (name, contract_type, playbook_id, party, paper, assignment, thresholds, status,
              round_robin_cursor, updated_at)
  on apps.ci_review_agent to legallabs_app;
create policy ci_review_agent_read on apps.ci_review_agent for select to legallabs_app
  using (core.in_tenant(workspace_id) and owner_id = core.current_user_id()
         and core.has_permission('threads.use'));
create policy ci_review_agent_insert on apps.ci_review_agent for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id()
              and core.has_permission('agents.build')
              and core.has_permission('playbooks.create')
              and work.playbook_level(playbook_id) is not null);
create policy ci_review_agent_update on apps.ci_review_agent for update to legallabs_app
  using (core.in_tenant(workspace_id) and owner_id = core.current_user_id()
         and core.has_permission('agents.build')
         and core.has_permission('playbooks.create'))
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id());

-- Seen by the agent's owner, the assignee and whoever handed it on, and only while they can
-- read the document (vault access and walls included).
grant select, insert on apps.ci_contract_review to legallabs_app;
grant update (status, result, summary, failure, assignee_id, assigned_by, playbook_review_id,
              run_id, playbook_id, next_attempt_at, started_at, done_at, updated_at)
  on apps.ci_contract_review to legallabs_app;
create policy ci_contract_review_read on apps.ci_contract_review for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and core.current_user_id() in (owner_id, assignee_id, assigned_by)
         and core.has_permission('threads.use')
         and exists (select 1 from content.document_version v where v.id = document_version_id));
create policy ci_contract_review_insert on apps.ci_contract_review for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id()
              and core.has_permission('agents.build')
              and core.has_permission('playbooks.create')
              and exists (select 1 from apps.ci_review_agent a where a.id = ci_agent_id)
              and exists (select 1 from content.document_version v
                           where v.id = ci_contract_review.document_version_id
                             and v.document_id = ci_contract_review.document_id));
create policy ci_contract_review_update on apps.ci_contract_review for update to legallabs_app
  using (core.in_tenant(workspace_id)
         and core.current_user_id() in (owner_id, assignee_id, assigned_by)
         and exists (select 1 from content.document_version v where v.id = document_version_id))
  with check (core.in_tenant(workspace_id));

-- The queue's worker only learns which rows are due and whose they are; the work itself is
-- done as that person.
grant select on apps.ci_review_agent to legallabs_definer;
grant select, update on apps.ci_contract_review to legallabs_definer;
create policy definer_read on apps.ci_review_agent for select to legallabs_definer using (true);
create policy definer_read on apps.ci_contract_review for select to legallabs_definer
  using (true);
create policy definer_update on apps.ci_contract_review for update to legallabs_definer
  using (true) with check (true);

create function apps.claim_ci_reviews(p_batch integer, p_lease_seconds integer,
                                      p_workspace uuid default null)
returns table (id uuid, workspace_id uuid, owner_id uuid)
language sql volatile security definer set search_path = '' as $$
  update apps.ci_contract_review r
     set next_attempt_at = pg_catalog.now()
                           + pg_catalog.make_interval(secs => p_lease_seconds)
   where r.id in (
     select x.id from apps.ci_contract_review x
       join apps.ci_review_agent a on a.id = x.ci_agent_id
      where x.status in ('queued', 'running')
        and x.next_attempt_at <= pg_catalog.now()
        -- A paused agent starts nothing; what it already started is still finished.
        and (x.status = 'running' or a.status = 'live')
        and (p_workspace is null or x.workspace_id = p_workspace)
      order by x.next_attempt_at, x.id
      limit p_batch
      for update of x skip locked)
  returning r.id, r.workspace_id, r.owner_id
$$;
alter function apps.claim_ci_reviews(integer, integer, uuid) owner to legallabs_definer;
revoke execute on function apps.claim_ci_reviews(integer, integer, uuid) from public;
grant execute on function apps.claim_ci_reviews(integer, integer, uuid) to legallabs_worker;

-- For a row its owner can no longer see (walled, removed or disabled): it can only fail.
create function apps.fail_ci_review(p_id uuid) returns void
language sql volatile security definer set search_path = '' as $$
  update apps.ci_contract_review
     set status = 'failed', failure = 'ACCESS_LOST', updated_at = pg_catalog.now()
   where id = p_id and status in ('queued', 'running')
$$;
alter function apps.fail_ci_review(uuid) owner to legallabs_definer;
revoke execute on function apps.fail_ci_review(uuid) from public;
grant execute on function apps.fail_ci_review(uuid) to legallabs_worker;

-- As 0089, with contract reviews: only people who could open one are told about it.
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
    else true
  end;
  perform pg_catalog.set_config('app.user_id', was, true);
  return coalesce(ok, false);
end
$$;
