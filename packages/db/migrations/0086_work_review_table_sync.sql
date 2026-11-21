-- A table over a vault can keep itself in step with it: new files become rows, and the
-- columns that have run before run on them. Sync works as the table's owner, so the owner's
-- walls apply to what it adds.
alter table work.review_table
  add column sync_mode text not null default 'off'
    check (sync_mode in ('off', 'entire_vault', 'selected_folders')),
  add column sync_folder_ids uuid[]
    check (cardinality(sync_folder_ids) between 1 and 100),
  -- Opt-in: tell the owner when a pass adds rows.
  add column sync_notify boolean not null default false,
  add column last_synced_at timestamptz,
  add check ((sync_mode = 'selected_folders') = (sync_folder_ids is not null)),
  add check (sync_mode = 'off' or source_kind = 'vault');

-- A row made by sync is pinned to the version it read, so a later version of the same file
-- is a new row and the verified cells on the old one stay as they were.
alter table work.rt_row
  add column version_id uuid,
  add column version_no integer check (version_no >= 1),
  -- True from the moment sync adds the row until its columns have been started on it.
  add column sync_pending boolean not null default false,
  add check ((version_id is null) = (version_no is null)),
  add foreign key (workspace_id, version_id) references content.document_version (workspace_id, id)
    on delete set null (version_id);
create index rt_row_sync_pending_idx on work.rt_row (table_id) where sync_pending;

grant update (sync_mode, sync_folder_ids, sync_notify, last_synced_at)
  on work.review_table to legallabs_app;
grant update (source_removed, sync_pending, version_id, version_no)
  on work.rt_row to legallabs_app;

-- Which tables are due a pass, across workspaces: the sync job has no identity of its own, so it
-- may learn only which table and which owner, then acts as that owner.
create function work.rt_sync_due() returns table (workspace_id uuid, table_id uuid, owner_id uuid)
language sql security definer set search_path = '' as $$
  select t.workspace_id, t.id, t.owner_id
    from work.review_table t
   where t.sync_mode <> 'off' and t.deleted_at is null
$$;
grant select (id, workspace_id, owner_id, sync_mode, deleted_at) on work.review_table
  to legallabs_definer;
create policy definer_sync on work.review_table for select to legallabs_definer using (true);
alter function work.rt_sync_due() owner to legallabs_definer;
revoke execute on function work.rt_sync_due() from public;
grant execute on function work.rt_sync_due() to legallabs_worker;

-- Sync flags a row once its file has left the vault, and that file is by then out of the
-- owner's sight. The check that a row names only readable files belongs to adding a row; it
-- must not stop the flag. What a row shows is decided when it is read, as before.
drop policy rt_row_all on work.rt_row;
create policy rt_row_read on work.rt_row for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from work.review_table t where t.id = table_id));
create policy rt_row_insert on work.rt_row for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and exists (select 1 from work.review_table t where t.id = table_id)
              and not exists (
                select 1 from unnest(document_ids) x(id)
                 where not exists (select 1 from content.document d where d.id = x.id)));
create policy rt_row_update on work.rt_row for update to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from work.review_table t where t.id = table_id))
  with check (core.in_tenant(workspace_id)
              and exists (select 1 from work.review_table t where t.id = table_id));
