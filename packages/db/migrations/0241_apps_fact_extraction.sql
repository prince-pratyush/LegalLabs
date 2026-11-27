-- Reading documents into a Space's fact table. An extraction is a run of its own kind, worked
-- from a Postgres queue as the person who asked, under the access they have at each step. The
-- run's events carry counts only; which files were read is in tables with their own policies.

alter table work.run
  drop constraint run_kind_check,
  add constraint run_kind_check check (kind in ('thread', 'deep_analysis', 'playbook_review',
    'rt_column', 'agent', 'workflow', 'agent_builder', 'assistant', 'fact_extraction')),
  drop constraint run_subject,
  add constraint run_subject check (
    case kind
      when 'rt_column' then table_id is not null and column_id is not null
                            and thread_id is null and question_id is null
      when 'playbook_review' then table_id is null and column_id is null
      when 'fact_extraction' then table_id is null and column_id is null and thread_id is null
                                  and question_id is null and space_id is not null
      else thread_id is not null and question_id is not null and table_id is null end);

create policy run_read_facts on work.run for select to legallabs_app
  using (core.in_tenant(workspace_id) and kind = 'fact_extraction'
         and owner_id = core.current_user_id()
         and space_id = any ((select apps.fact_spaces())::uuid[]));
create policy run_insert_facts on work.run for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and kind = 'fact_extraction'
              and owner_id = core.current_user_id()
              and core.has_permission('threads.use')
              and space_id = any ((select apps.fact_spaces())::uuid[])
              and core.can_access_matter(matter_id));
create policy run_update_facts on work.run for update to legallabs_app
  using (core.in_tenant(workspace_id) and kind = 'fact_extraction'
         and owner_id = core.current_user_id()
         and space_id = any ((select apps.fact_spaces())::uuid[]))
  with check (core.in_tenant(workspace_id) and kind = 'fact_extraction'
              and owner_id = core.current_user_id());

create table apps.fact_extraction (
  -- The run's id.
  id uuid primary key,
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  space_id uuid not null,
  requested_by uuid not null,
  state text not null default 'queued'
    check (state in ('queued', 'running', 'done', 'partial', 'failed', 'cancelled')),
  failure text check (char_length(failure) <= 40),
  -- Tag only these issues; empty takes any, and may propose new ones.
  issue_ids uuid[] not null default '{}' check (cardinality(issue_ids) <= 50),
  facts_found integer not null default 0 check (facts_found >= 0),
  rejected_unverified integer not null default 0 check (rejected_unverified >= 0),
  rejected_invalid integer not null default 0 check (rejected_invalid >= 0),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, id) references work.run (workspace_id, id) on delete cascade,
  foreign key (workspace_id, space_id) references work.space (workspace_id, id) on delete cascade,
  foreign key (workspace_id, requested_by) references core."user" (workspace_id, id)
);
create index fact_extraction_space_idx on apps.fact_extraction (space_id, created_at desc);
create index fact_extraction_due_idx on apps.fact_extraction (next_attempt_at)
  where state in ('queued', 'running');

create table apps.fact_extraction_document (
  extraction_id uuid not null,
  document_id uuid not null,
  workspace_id uuid not null,
  document_version_id uuid,
  position integer not null check (position >= 0),
  state text not null default 'pending' check (state in ('pending', 'read', 'partial', 'failed')),
  reason text check (char_length(reason) <= 40),
  pages_total integer not null default 0 check (pages_total >= 0),
  pages_read integer not null default 0 check (pages_read >= 0),
  facts integer not null default 0 check (facts >= 0),
  rejected integer not null default 0 check (rejected >= 0),
  attempts integer not null default 0 check (attempts >= 0),
  primary key (extraction_id, document_id),
  -- Read in full means every page, and nothing given as a reason.
  check (state <> 'read' or (reason is null and pages_read = pages_total)),
  foreign key (workspace_id, extraction_id) references apps.fact_extraction (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, document_id) references content.document (workspace_id, id)
    on delete cascade
);

alter table apps.fact_extraction enable row level security;
alter table apps.fact_extraction force row level security;
alter table apps.fact_extraction_document enable row level security;
alter table apps.fact_extraction_document force row level security;

grant select, insert on apps.fact_extraction, apps.fact_extraction_document to legallabs_app;
grant update (state, failure, facts_found, rejected_unverified, rejected_invalid, cost_usd,
              next_attempt_at, finished_at) on apps.fact_extraction to legallabs_app;
grant update (state, reason, pages_total, pages_read, facts, rejected, attempts)
  on apps.fact_extraction_document to legallabs_app;

-- An extraction is its requester's, while they are still in the Space.
create policy fact_extraction_read on apps.fact_extraction for select to legallabs_app
  using (core.in_tenant(workspace_id) and requested_by = core.current_user_id()
         and space_id = any ((select apps.fact_spaces())::uuid[]));
create policy fact_extraction_insert on apps.fact_extraction for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and requested_by = core.current_user_id()
              and core.has_permission('threads.use')
              and space_id = any ((select apps.fact_spaces())::uuid[])
              and state = 'queued' and facts_found = 0 and cost_usd = 0
              and exists (select 1 from work.run r
                           where r.id = fact_extraction.id and r.kind = 'fact_extraction'
                             and r.space_id = fact_extraction.space_id));
create policy fact_extraction_update on apps.fact_extraction for update to legallabs_app
  using (core.in_tenant(workspace_id) and requested_by = core.current_user_id()
         and space_id = any ((select apps.fact_spaces())::uuid[]))
  with check (core.in_tenant(workspace_id) and requested_by = core.current_user_id());

create policy fact_extraction_document_read on apps.fact_extraction_document
  for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from apps.fact_extraction x where x.id = extraction_id));
create policy fact_extraction_document_insert on apps.fact_extraction_document
  for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and exists (select 1 from apps.fact_extraction x where x.id = extraction_id)
              and exists (select 1 from content.document d where d.id = document_id));
create policy fact_extraction_document_update on apps.fact_extraction_document
  for update to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from apps.fact_extraction x where x.id = extraction_id))
  with check (core.in_tenant(workspace_id));

-- The queue's worker only learns which extraction is due and whose it is; the reading is done
-- as that person.
grant select, update on apps.fact_extraction to legallabs_definer;
create policy definer_read on apps.fact_extraction for select to legallabs_definer using (true);
create policy definer_update on apps.fact_extraction for update to legallabs_definer
  using (true) with check (true);

create function apps.claim_fact_extraction(p_lease_seconds integer, p_workspace uuid default null,
                                           p_skip uuid[] default '{}')
returns table (id uuid, workspace_id uuid, requested_by uuid, space_id uuid)
language sql volatile security definer set search_path = '' as $$
  update apps.fact_extraction e
     set next_attempt_at = pg_catalog.now()
                           + pg_catalog.make_interval(secs => p_lease_seconds)
   where e.id = (
     select x.id from apps.fact_extraction x
      where x.state in ('queued', 'running')
        and x.next_attempt_at <= pg_catalog.now()
        and (p_workspace is null or x.workspace_id = p_workspace)
        and x.id <> all (p_skip)
      order by x.next_attempt_at, x.id
      limit 1
      for update skip locked)
  returning e.id, e.workspace_id, e.requested_by, e.space_id
$$;
alter function apps.claim_fact_extraction(integer, uuid, uuid[]) owner to legallabs_definer;
revoke execute on function apps.claim_fact_extraction(integer, uuid, uuid[]) from public;
grant execute on function apps.claim_fact_extraction(integer, uuid, uuid[]) to legallabs_worker;

-- For an extraction its requester can no longer work (removed, walled, disabled or without the
-- permission): it stops and fails. The audit event is the system's: there is nobody to act as.
create function apps.fail_fact_extraction(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  was text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  ws uuid;
begin
  update apps.fact_extraction
     set state = 'failed', failure = 'ACCESS_LOST', finished_at = pg_catalog.now()
   where id = p_id and state in ('queued', 'running')
  returning workspace_id into ws;
  if ws is null then
    return;
  end if;
  update work.run set status = 'failed', updated_at = pg_catalog.now()
   where id = p_id and status not in ('done', 'failed', 'cancelled');
  perform pg_catalog.set_config('app.workspace_id', ws::text, true);
  perform admin.append_audit_event('facts.extraction_failed', 'system', null, 'run', p_id::text,
                                   '{"failure": "ACCESS_LOST"}'::jsonb);
  perform pg_catalog.set_config('app.workspace_id', was, true);
end
$$;
alter function apps.fail_fact_extraction(uuid) owner to legallabs_definer;
revoke execute on function apps.fail_fact_extraction(uuid) from public;
grant execute on function apps.fail_fact_extraction(uuid) to legallabs_worker;
