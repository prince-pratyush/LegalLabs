-- At 10,000 files the row checks dominate search: each chunk re-ran the membership check and
-- the wall check through its version and document. A scalar subquery runs once per statement,
-- so these say the same as before and cost one lookup per row instead of a function call.
drop policy document_read on content.document;
create policy document_read on content.document for select to legallabs_app
  using (workspace_id = core.current_workspace_id()
         and (select core.is_active_member())
         and deleted_at is null
         and (matter_id is null
              or matter_id = any ((select content.accessible_matters())::uuid[]))
         and case when vault_id is null then owner_id = core.current_user_id()
                  else vault_id = any ((select content.readable_vaults('view'))::uuid[]) end);

drop policy version_read on content.document_version;
create policy version_read on content.document_version for select to legallabs_app
  using (workspace_id = core.current_workspace_id()
         and (select core.is_active_member())
         and exists (select 1 from content.document d where d.id = document_id));

drop policy page_read on content.page;
create policy page_read on content.page for select to legallabs_app
  using (workspace_id = core.current_workspace_id()
         and (select core.is_active_member())
         and exists (select 1 from content.document_version v where v.id = version_id));

drop policy chunk_read on content.chunk;
create policy chunk_read on content.chunk for select to legallabs_app
  using (workspace_id = core.current_workspace_id()
         and (select core.is_active_member())
         and exists (select 1 from content.document_version v where v.id = version_id));

drop policy job_read on content.ingest_job;
create policy job_read on content.ingest_job for select to legallabs_app
  using (workspace_id = core.current_workspace_id()
         and (select core.is_active_member())
         and exists (select 1 from content.document_version v where v.id = version_id));

-- Seeing a document used to mean owning it, so these only checked that it was visible. A vault
-- viewer can see it too, and must not add text that others' answers would cite.
create function content.can_write_document(p_document uuid) returns boolean
language plpgsql stable set search_path = '' as $$
begin
  return exists (
    select 1 from content.document d
     where d.id = p_document
       and case when d.vault_id is null then d.owner_id = core.current_user_id()
                else d.vault_id = any (content.readable_vaults('edit')) end);
end
$$;

drop policy version_insert on content.document_version;
create policy version_insert on content.document_version for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and created_by = core.current_user_id()
              and content.can_write_document(document_id));

-- Only the uploader's own reading of a version writes its pages and passages.
drop policy page_insert on content.page;
create policy page_insert on content.page for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and exists (
    select 1 from content.document_version v
     where v.id = version_id and v.created_by = core.current_user_id()
       and content.can_write_document(v.document_id)));

drop policy chunk_insert on content.chunk;
create policy chunk_insert on content.chunk for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and exists (
    select 1 from content.document_version v
     where v.id = version_id and v.created_by = core.current_user_id()
       and content.can_write_document(v.document_id)));

revoke execute on all functions in schema content from public;
grant execute on function content.can_write_document(uuid) to legallabs_app;
