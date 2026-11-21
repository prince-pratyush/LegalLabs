-- A column run is a run like a thread turn, so it shares the event log and the SSE stream.
-- Runs after the playbook reviews migration, which already let a run stand without a thread.
alter table work.run
  alter column thread_id drop not null,
  alter column question_id drop not null,
  add column table_id uuid,
  add column column_id uuid,
  add column scope jsonb,
  drop constraint run_kind_check,
  add constraint run_kind_check
    check (kind in ('thread', 'deep_analysis', 'playbook_review', 'rt_column')),
  drop constraint if exists run_thread_check,
  -- Each run belongs to exactly one thing: a thread turn, a review, or a table column.
  add constraint run_subject check (
    case kind
      when 'rt_column' then table_id is not null and column_id is not null
                            and thread_id is null and question_id is null
      when 'playbook_review' then table_id is null and column_id is null
      else thread_id is not null and question_id is not null and table_id is null end),
  add foreign key (workspace_id, table_id) references work.review_table (workspace_id, id)
    on delete cascade,
  add foreign key (workspace_id, column_id) references work.rt_column (workspace_id, id)
    on delete cascade;
create index run_table_idx on work.run (table_id, status) where table_id is not null;

-- Table runs are seen and driven by the table's owner, who is the one clicking Run.
create policy run_read_table on work.run for select to legallabs_app
  using (core.in_tenant(workspace_id) and table_id is not null and exists (
    select 1 from work.review_table t where t.id = table_id));
create policy run_insert_table on work.run for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and kind = 'rt_column'
              and owner_id = core.current_user_id()
              and exists (select 1 from work.review_table t
                           where t.id = table_id and t.owner_id = core.current_user_id()));
create policy run_update_table on work.run for update to legallabs_app
  using (core.in_tenant(workspace_id) and table_id is not null
         and owner_id = core.current_user_id()
         and exists (select 1 from work.review_table t where t.id = table_id))
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id());

create policy run_event_insert_table on work.run_event for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and exists (
    select 1 from work.run r
     where r.id = run_id and r.table_id is not null and r.owner_id = core.current_user_id()));

-- Runs live in one process: after a restart, cells left queued or running by a run that was
-- failed at startup go back to waiting. Only the worker role calls this, after
-- work.fail_orphaned_runs.
create function work.rt_reset_orphaned_cells() returns integer
language sql security definer set search_path = '' as $$
  with reset as (
    update work.rt_cell c
       set status = case when c.value_text is null then 'pending' else 'stale' end,
           stale_since = case when c.value_text is null then null else now() end,
           error_code = null, updated_at = now()
     where c.status in ('queued', 'running')
       and not exists (select 1 from work.run r where r.id = c.run_id and r.status = 'running')
    returning 1
  ), columns as (
    update work.rt_column k set state = 'stopped', updated_at = now()
     where k.state = 'running'
       and not exists (select 1 from work.run r where r.id = k.run_id and r.status = 'running')
    returning 1)
  select (select count(*)::int from reset) + (select count(*)::int from columns)
$$;
grant select, update (status, stale_since, error_code, updated_at) on work.rt_cell
  to legallabs_definer;
grant select, update (state, updated_at) on work.rt_column to legallabs_definer;
create policy definer_stop on work.rt_column for update to legallabs_definer
  using (true) with check (true);
create policy definer_read on work.rt_column for select to legallabs_definer using (true);
create policy definer_reset on work.rt_cell for update to legallabs_definer
  using (true) with check (true);
create policy definer_read on work.rt_cell for select to legallabs_definer using (true);
alter function work.rt_reset_orphaned_cells() owner to legallabs_definer;
revoke execute on function work.rt_reset_orphaned_cells() from public;
grant execute on function work.rt_reset_orphaned_cells() to legallabs_worker;
