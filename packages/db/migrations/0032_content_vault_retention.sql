-- Each vault's retention moves its old files to the recycle bin; the bin empties after 30 days.
-- Both run from the background job, so they act for no one and are audited as the system.
create function content.sweep_vault_retention() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  ws record;
  moved integer;
  total integer := 0;
begin
  for ws in
    select v.workspace_id, array_agg(v.id) vaults
      from content.vault v
     where v.retention_hours is not null and v.deleted_at is null
     group by v.workspace_id
  loop
    update content.document d
       set deleted_at = now(), deleted_reason = 'retention', updated_at = now()
      from content.vault v
     where v.id = d.vault_id and v.id = any (ws.vaults)
       and d.deleted_at is null
       and d.created_at < now() - make_interval(hours => v.retention_hours);
    get diagnostics moved = row_count;
    if moved > 0 then
      perform set_config('app.user_id', '', true);
      perform set_config('app.workspace_id', ws.workspace_id::text, true);
      perform admin.append_audit_event('retention.sweep', 'system', null, null, null,
        jsonb_build_object('documents', moved, 'vaults', cardinality(ws.vaults)));
      total := total + moved;
    end if;
  end loop;
  perform set_config('app.workspace_id', '', true);
  return total;
end
$$;

create function content.purge_expired_bin(p_days integer)
returns table (workspace_id uuid, sha256 bytea)
language plpgsql security definer set search_path = '' as $$
declare
  ws record;
  cutoff timestamptz := now() - make_interval(days => greatest(p_days, 1));
begin
  for ws in
    select w.id,
           coalesce((select array_agg(v.id) from content.vault v
                      where v.workspace_id = w.id and v.deleted_at < cutoff), '{}') vaults,
           coalesce((select array_agg(f.id) from content.folder f
                      where f.workspace_id = w.id and f.deleted_at < cutoff), '{}') folders,
           coalesce((select array_agg(d.id) from content.document d
                      where d.workspace_id = w.id and d.deleted_at < cutoff), '{}') documents
      from core.workspace w
  loop
    continue when cardinality(ws.vaults) + cardinality(ws.folders) + cardinality(ws.documents) = 0;
    return query
      select ws.id, p.sha256 from content.purge(ws.id, ws.vaults, ws.folders, ws.documents) p;
    perform set_config('app.user_id', '', true);
    perform set_config('app.workspace_id', ws.id::text, true);
    perform admin.append_audit_event('deletion.completed', 'system', null, null, null,
      jsonb_build_object('vaults', cardinality(ws.vaults), 'folders', cardinality(ws.folders),
                         'documents', cardinality(ws.documents)));
  end loop;
  perform set_config('app.workspace_id', '', true);
end
$$;

alter function content.sweep_vault_retention() owner to legallabs_definer;
alter function content.purge_expired_bin(integer) owner to legallabs_definer;
revoke execute on all functions in schema content from public;
grant execute on function content.sweep_vault_retention(), content.purge_expired_bin(integer)
  to legallabs_worker;
