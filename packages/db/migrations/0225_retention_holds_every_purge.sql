-- SEC (06-security 5.6), finding F-39: a legal hold stopped the retention sweep but not the
-- vault bin. Purging a binned folder or vault, by the hourly job or by an admin, destroyed held
-- files, and purging a parent file took a held attachment with it.

-- As 0121, and a file is held while anything filed under it is: deleting it would cascade.
create or replace function retention._is_held(p_ws uuid, p_type text, p_id uuid) returns boolean
language sql stable set search_path = '' as $$
  with recursive subject(id) as (
    select p_id
    union
    select d.id from content.document d join subject s on d.parent_id = s.id
     where p_type = 'document' and d.workspace_id = p_ws
  )
  select exists (
    select 1 from retention.hold h cross join subject s
     where h.workspace_id = p_ws
       and ((h.object_type = p_type and h.object_id = s.id)
            or (h.object_type = 'vault' and p_type = 'document'
                and h.object_id = (select d.vault_id from content.document d where d.id = s.id))
            or (h.object_type = 'matter' and h.object_id = case p_type
                  when 'thread' then (select t.matter_id from work.thread t where t.id = s.id)
                  when 'review_table' then (select r.matter_id from work.review_table r
                                             where r.id = s.id)
                  when 'document' then (select coalesce(d.matter_id, v.matter_id)
                                          from content.document d
                                          left join content.vault v on v.id = d.vault_id
                                         where d.id = s.id) end)))
$$;

-- Whether anything under a folder, at any depth, is held.
create function content.folder_held(p_workspace uuid, p_folder uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with recursive tree(id) as (
    select p_folder
    union
    select f.id from content.folder f join tree on f.parent_id = tree.id
     where f.workspace_id = p_workspace
  )
  select exists (select 1 from content.document d join tree on d.folder_id = tree.id
                  where d.workspace_id = p_workspace
                    and retention._is_held(p_workspace, 'document', d.id))
$$;

-- Whether a vault, its matter or anything in it is held.
create function content.vault_held(p_workspace uuid, p_vault uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from retention.hold h
                  where h.workspace_id = p_workspace
                    and ((h.object_type = 'vault' and h.object_id = p_vault)
                         or (h.object_type = 'matter' and h.object_id =
                               (select v.matter_id from content.vault v
                                 where v.id = p_vault and v.workspace_id = p_workspace))))
      or exists (select 1 from content.document d
                  where d.workspace_id = p_workspace and d.vault_id = p_vault
                    and retention._is_held(p_workspace, 'document', d.id))
$$;
alter function content.folder_held(uuid, uuid) owner to legallabs_definer;
alter function content.vault_held(uuid, uuid) owner to legallabs_definer;
revoke execute on function content.folder_held(uuid, uuid), content.vault_held(uuid, uuid)
  from public;
grant execute on function content.folder_held(uuid, uuid), content.vault_held(uuid, uuid),
  retention._is_held(uuid, text, uuid) to legallabs_definer;

-- Every deletion of files goes through here, so what is held is dropped from the request here.
create or replace function content.purge(p_workspace uuid, p_vaults uuid[], p_folders uuid[],
                                         p_documents uuid[])
returns table (sha256 bytea)
language plpgsql security definer set search_path = '' as $$
declare
  hashes bytea[];
  vaults uuid[];
  folders uuid[];
  documents uuid[];
begin
  select coalesce(array_agg(x), '{}') into vaults from unnest(p_vaults) x
   where not content.vault_held(p_workspace, x);
  select coalesce(array_agg(x), '{}') into folders from unnest(p_folders) x
   where not content.folder_held(p_workspace, x);
  select coalesce(array_agg(x), '{}') into documents from unnest(p_documents) x
   where not retention._is_held(p_workspace, 'document', x);
  select coalesce(array_agg(distinct v.sha256), '{}') into hashes
    from content.document_version v join content.document d on d.id = v.document_id
   where d.workspace_id = p_workspace
     and (d.id = any (documents) or d.folder_id = any (folders) or d.vault_id = any (vaults));
  delete from content.document d
   where d.workspace_id = p_workspace
     and (d.id = any (documents) or d.folder_id = any (folders) or d.vault_id = any (vaults));
  delete from content.folder f
   where f.workspace_id = p_workspace and (f.id = any (folders) or f.vault_id = any (vaults));
  delete from core.share_grant g
   where g.workspace_id = p_workspace and g.object_type = 'vault' and g.object_id = any (vaults);
  delete from content.vault v where v.workspace_id = p_workspace and v.id = any (vaults);
  return query
    select h from unnest(hashes) h
     where not exists (select 1 from content.document_version v
                        where v.workspace_id = p_workspace and v.sha256 = h);
end
$$;

-- As 0122, counting and auditing only what can go.
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
                        and not content.vault_held(w.id, v.id)), '{}') vaults,
           coalesce((select array_agg(f.id) from content.folder f
                      where f.workspace_id = w.id and f.deleted_at < cutoff
                        and not content.folder_held(w.id, f.id)), '{}') folders,
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

-- As 0031, refusing a vault under hold.
create or replace function content.purge_vault(p_vault uuid) returns table (sha256 bytea)
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
begin
  if not core.has_permission('admin.config') or not exists (
    select 1 from content.vault v
     where v.id = p_vault and v.workspace_id = ws and v.deleted_at is not null) then
    raise exception 'only a deleted vault can be purged, by an admin' using errcode = '42501';
  end if;
  if content.vault_held(ws, p_vault) then
    raise exception 'HELD' using errcode = '55006';
  end if;
  return query select p.sha256 from content.purge(ws, array[p_vault], '{}', '{}') p;
end
$$;
