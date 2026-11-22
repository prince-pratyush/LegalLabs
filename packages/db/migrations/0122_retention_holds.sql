-- Holds protect what retention would remove, in the older vault job as well as the new sweep.
-- Same behaviour and return types as before for anything that is not held.
create or replace function content.sweep_vault_retention() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  ws record;
  doc record;
  moved integer;
  total integer := 0;
begin
  for ws in
    select v.workspace_id, array_agg(v.id) vaults
      from content.vault v
     where v.retention_hours is not null and v.deleted_at is null
     group by v.workspace_id
  loop
    perform set_config('app.user_id', '', true);
    perform set_config('app.workspace_id', ws.workspace_id::text, true);
    moved := 0;
    for doc in
      update content.document d
         set deleted_at = now(), deleted_reason = 'retention', updated_at = now()
        from content.vault v
       where v.id = d.vault_id and v.id = any (ws.vaults)
         and d.deleted_at is null
         and d.created_at < now() - make_interval(hours => v.retention_hours)
         and not retention._is_held(d.workspace_id, 'document', d.id)
      returning d.id, d.vault_id
    loop
      perform admin.append_audit_event('document.deleted', 'system', null, 'document',
        doc.id::text, jsonb_build_object('deleted_reason', 'retention', 'vault_id', doc.vault_id));
      moved := moved + 1;
    end loop;
    if moved > 0 then
      perform admin.append_audit_event('retention.sweep', 'system', null, null, null,
        jsonb_build_object('documents', moved, 'vaults', cardinality(ws.vaults)));
      total := total + moved;
    end if;
  end loop;
  perform set_config('app.workspace_id', '', true);
  return total;
end
$$;

create or replace function content.purge_expired_bin(p_days integer)
returns table (workspace_id uuid, sha256 bytea)
language plpgsql security definer set search_path = '' as $$
declare
  ws record;
  cutoff timestamptz := now() - make_interval(days => greatest(p_days, 1));
begin
  for ws in
    select w.id,
           coalesce((select array_agg(v.id) from content.vault v
                      where v.workspace_id = w.id and v.deleted_at < cutoff
                        and not exists (select 1 from retention.hold h
                                         where h.object_type = 'vault' and h.object_id = v.id)),
                    '{}') vaults,
           coalesce((select array_agg(f.id) from content.folder f
                      where f.workspace_id = w.id and f.deleted_at < cutoff), '{}') folders,
           coalesce((select array_agg(d.id) from content.document d
                      where d.workspace_id = w.id
                        and (d.deleted_at < cutoff or d.deleted_reason = 'retention')
                        and not retention._is_held(w.id, 'document', d.id)),
                    '{}') documents
      from core.workspace w
  loop
    continue when cardinality(ws.vaults) + cardinality(ws.folders) + cardinality(ws.documents) = 0;
    -- Set first: grant deletes are allowed only inside the current workspace.
    perform set_config('app.user_id', '', true);
    perform set_config('app.workspace_id', ws.id::text, true);
    return query
      select ws.id, p.sha256 from content.purge(ws.id, ws.vaults, ws.folders, ws.documents) p;
    perform admin.append_audit_event('deletion.completed', 'system', null, null, null,
      jsonb_build_object('vaults', cardinality(ws.vaults), 'folders', cardinality(ws.folders),
                         'documents', cardinality(ws.documents)));
  end loop;
  perform set_config('app.workspace_id', '', true);
end
$$;


-- A binned thread is not the owner's any more, so the share helpers stop finding it too.
create or replace function work.owned_thread(thread_id uuid) returns work.thread
language sql stable security definer set search_path = '' as $$
  select t.* from work.thread t
   where t.id = owned_thread.thread_id
     and t.workspace_id = core.current_workspace_id()
     and t.owner_id = core.current_user_id()
     and t.deleted_at is null
     and core.has_permission('threads.use')
     and core.can_access_matter(t.matter_id)
$$;
