-- Deletes, restores, shares and transfers go through these functions, so each checks the
-- caller's level once and touches every row it needs, including ones the caller can't see.
grant update (deleted_at, deleted_by, owner_id, updated_at), delete on content.vault
  to legallabs_definer;
grant update (deleted_at, deleted_by, parent_id), delete on content.folder to legallabs_definer;
grant update (deleted_at, deleted_by, deleted_reason, folder_id, updated_at), delete
  on content.document to legallabs_definer;
create policy definer_write on content.vault for update to legallabs_definer
  using (true) with check (true);
create policy definer_delete on content.vault for delete to legallabs_definer using (true);
create policy definer_write on content.folder for update to legallabs_definer
  using (true) with check (true);
create policy definer_delete on content.folder for delete to legallabs_definer using (true);
create policy definer_write on content.document for update to legallabs_definer
  using (true) with check (true);
create policy definer_delete on content.document for delete to legallabs_definer using (true);

grant insert, delete on core.share_grant to legallabs_definer;
create policy definer_insert on core.share_grant for insert to legallabs_definer
  with check (true);
create policy definer_delete on core.share_grant for delete to legallabs_definer using (true);

create function content.require_level(p_vault uuid, p_levels text[]) returns void
language plpgsql stable set search_path = '' as $$
declare
  lvl text := content.vault_level(p_vault);
begin
  if lvl is null or not (lvl = any (p_levels)) then
    raise exception 'not allowed on this vault' using errcode = '42501';
  end if;
end
$$;

-- The same rule as core.can_access_matter, asked about someone else.
create function content.user_can_access_matter(p_user uuid, p_matter uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with principals as (
    select 'user' as type, p_user as id
    union all
    select 'group', m.group_id from core.group_member m where m.user_id = p_user
  )
  select p_matter is null or coalesce((
    select not exists (
             select 1 from core.wall w join principals p
               on w.principal_type = p.type and w.principal_id = p.id
              where w.matter_id = mt.id and w.effect = 'deny')
           and ((mt.wall_mode = 'open' and exists (
                  select 1 from core."user" u where u.id = p_user and u.kind = 'member'))
                or exists (
             select 1 from core.wall w join principals p
               on w.principal_type = p.type and w.principal_id = p.id
              where w.matter_id = mt.id and w.effect = 'allow'))
      from core.matter mt where mt.id = p_matter), false)
$$;

-- One timestamp for the whole call, so a restore brings back exactly what went together.
create function content.trash_items(p_vault uuid, p_document_ids uuid[], p_folder_ids uuid[])
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := core.current_user_id();
  stamp timestamptz := now();
  folders integer;
  documents integer;
begin
  perform content.require_level(p_vault, array['owner', 'full', 'edit']);
  with recursive tree as (
    select f.id from content.folder f
     where f.vault_id = p_vault and f.id = any (p_folder_ids) and f.deleted_at is null
    union
    select f.id from content.folder f join tree on f.parent_id = tree.id
     where f.deleted_at is null
  )
  update content.folder f set deleted_at = stamp, deleted_by = me
    from tree where f.id = tree.id;
  get diagnostics folders = row_count;
  -- Walled files inside a deleted folder go with it, and come back with it.
  with recursive picked as (
    select d.id from content.document d
     where d.vault_id = p_vault and d.deleted_at is null
       and ((d.id = any (p_document_ids) and core.can_access_matter(d.matter_id))
            or d.folder_id in (select f.id from content.folder f
                                where f.vault_id = p_vault and f.deleted_at = stamp))
    union
    select d.id from content.document d join picked on d.parent_id = picked.id
     where d.deleted_at is null
  )
  update content.document d
     set deleted_at = stamp, deleted_by = me, deleted_reason = 'user', updated_at = stamp
    from picked where d.id = picked.id;
  get diagnostics documents = row_count;
  return folders + documents;
end
$$;

-- Brings items back with whatever was deleted alongside them; an item whose folder is still
-- in the bin comes back at the top of the vault.
create function content.restore_items(p_vault uuid, p_document_ids uuid[], p_folder_ids uuid[])
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  folder_ids uuid[];
  folders integer;
  documents integer;
begin
  perform content.require_level(p_vault, array['owner', 'full', 'edit']);
  with recursive tree as (
    select f.id, f.deleted_at from content.folder f
     where f.vault_id = p_vault and f.id = any (p_folder_ids) and f.deleted_at is not null
    union
    select f.id, f.deleted_at from content.folder f join tree on f.parent_id = tree.id
     where f.deleted_at = tree.deleted_at
  )
  select coalesce(array_agg(id), '{}') into folder_ids from tree;
  -- Documents first, while their folders still carry the stamp they were deleted with.
  with recursive picked as (
    select d.id, d.deleted_at from content.document d
     where d.vault_id = p_vault and d.deleted_at is not null
       and d.deleted_reason = 'user'
       and ((d.id = any (p_document_ids) and core.can_access_matter(d.matter_id))
            or exists (select 1 from content.folder f
                        where f.id = d.folder_id and f.id = any (folder_ids)
                          and f.deleted_at = d.deleted_at))
    union
    select d.id, d.deleted_at from content.document d join picked on d.parent_id = picked.id
     where d.deleted_at = picked.deleted_at
  )
  update content.document d
     set deleted_at = null, deleted_by = null, deleted_reason = null, updated_at = now(),
         folder_id = case when d.folder_id = any (folder_ids) or not exists (
                                select 1 from content.folder f
                                 where f.id = d.folder_id and f.deleted_at is not null)
                          then d.folder_id end
    from picked where d.id = picked.id;
  get diagnostics documents = row_count;
  update content.folder f set deleted_at = null, deleted_by = null
   where f.id = any (folder_ids);
  get diagnostics folders = row_count;
  update content.folder f set parent_id = null
   where f.id = any (folder_ids)
     and exists (select 1 from content.folder p
                  where p.id = f.parent_id and p.deleted_at is not null);
  return folders + documents;
end
$$;

-- What the bin shows: top-level items only, never a walled file's name.
create function content.vault_bin(p_vault uuid)
returns table (kind text, id uuid, name text, deleted_at timestamptz, deleted_by uuid,
               deleted_reason text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform content.require_level(p_vault, array['owner', 'full', 'edit']);
  return query
    select * from (
      select 'folder'::text, f.id, f.name, f.deleted_at, f.deleted_by, 'user'::text
        from content.folder f
       where f.vault_id = p_vault and f.deleted_at is not null
         and not exists (select 1 from content.folder p
                          where p.id = f.parent_id and p.deleted_at = f.deleted_at)
      union all
      select 'document'::text, d.id, d.name, d.deleted_at, d.deleted_by, d.deleted_reason
        from content.document d
       where d.vault_id = p_vault and d.deleted_at is not null
         and core.can_access_matter(d.matter_id)
         and not exists (select 1 from content.folder f
                          where f.id = d.folder_id and f.deleted_at = d.deleted_at)
         and not exists (select 1 from content.document p
                          where p.id = d.parent_id and p.deleted_at = d.deleted_at)
    ) items
     order by 4 desc, 3;
end
$$;

create function content.trash_vault(p_vault uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform content.require_level(p_vault, array['owner', 'full']);
  update content.vault set deleted_at = now(), deleted_by = core.current_user_id()
   where id = p_vault;
end
$$;

create function content.restore_vault(p_vault uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update content.vault v set deleted_at = null, deleted_by = null, updated_at = now()
   where v.id = p_vault and v.deleted_at is not null
     and v.workspace_id = core.current_workspace_id() and core.is_active_member()
     and core.can_access_matter(v.matter_id)
     and (v.owner_id = core.current_user_id() or core.has_permission('admin.config'));
  return found;
end
$$;

-- Removes rows for good and returns the stored files nothing points at any more.
create function content.purge(p_workspace uuid, p_vaults uuid[], p_folders uuid[],
                              p_documents uuid[])
returns table (sha256 bytea)
language plpgsql security definer set search_path = '' as $$
declare
  hashes bytea[];
begin
  select coalesce(array_agg(distinct v.sha256), '{}') into hashes
    from content.document_version v join content.document d on d.id = v.document_id
   where d.workspace_id = p_workspace
     and (d.id = any (p_documents) or d.folder_id = any (p_folders)
          or d.vault_id = any (p_vaults));
  delete from content.document d
   where d.workspace_id = p_workspace
     and (d.id = any (p_documents) or d.folder_id = any (p_folders)
          or d.vault_id = any (p_vaults));
  delete from content.folder f
   where f.workspace_id = p_workspace and (f.id = any (p_folders) or f.vault_id = any (p_vaults));
  delete from core.share_grant g
   where g.workspace_id = p_workspace and g.object_type = 'vault' and g.object_id = any (p_vaults);
  delete from content.vault v where v.workspace_id = p_workspace and v.id = any (p_vaults);
  return query
    select h from unnest(hashes) h
     where not exists (select 1 from content.document_version v
                        where v.workspace_id = p_workspace and v.sha256 = h);
end
$$;

-- An admin empties a deleted vault from the bin before its 30 days are up.
create function content.purge_vault(p_vault uuid) returns table (sha256 bytea)
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
begin
  if not core.has_permission('admin.config') or not exists (
    select 1 from content.vault v
     where v.id = p_vault and v.workspace_id = ws and v.deleted_at is not null) then
    raise exception 'only a deleted vault can be purged, by an admin' using errcode = '42501';
  end if;
  return query select p.sha256 from content.purge(ws, array[p_vault], '{}', '{}') p;
end
$$;

-- The old owner keeps full access, so a transfer never locks anyone out.
create function content.transfer_vault(p_vault uuid, p_new_owner uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  previous uuid;
begin
  if not core.has_permission('admin.config') then
    raise exception 'only an admin can transfer a vault' using errcode = '42501';
  end if;
  select v.owner_id into previous from content.vault v
   where v.id = p_vault and v.workspace_id = ws and v.deleted_at is null for update;
  if previous is null or not exists (
    select 1 from core."user" u
     where u.id = p_new_owner and u.workspace_id = ws and u.status = 'active'
       and u.kind = 'member') then
    return false;
  end if;
  if previous = p_new_owner then
    return true;
  end if;
  update content.vault set owner_id = p_new_owner, updated_at = now() where id = p_vault;
  delete from core.share_grant g
   where g.object_type = 'vault' and g.object_id = p_vault and g.principal_type = 'user'
     and g.principal_id in (previous, p_new_owner);
  insert into core.share_grant
    (workspace_id, object_type, object_id, principal_type, principal_id, level, granted_by)
  values (ws, 'vault', p_vault, 'user', previous, 'full', core.current_user_id());
  return true;
end
$$;

-- Replaces every grant on a vault. On a matter vault a walled user is refused, and a group
-- is granted with its walled members listed: walls still hide the vault from them.
create function content.set_vault_shares(p_vault uuid, p_grants jsonb, p_workspace_view boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  me uuid := core.current_user_id();
  vault_matter uuid;
  vault_owner uuid;
  g jsonb;
  denied uuid[] := '{}';
  kind text;
  principal uuid;
  lvl text;
begin
  perform content.require_level(p_vault, array['owner', 'full']);
  select v.matter_id, v.owner_id into vault_matter, vault_owner
    from content.vault v where v.id = p_vault;
  delete from core.share_grant s where s.object_type = 'vault' and s.object_id = p_vault;
  for g in select * from jsonb_array_elements(coalesce(p_grants, '[]')) loop
    kind := g ->> 'principal_type';
    principal := (g ->> 'principal_id')::uuid;
    lvl := g ->> 'level';
    if kind is null or kind not in ('user', 'group') or lvl is null
       or lvl not in ('view', 'edit', 'full') then
      raise exception 'unknown principal or level' using errcode = '22023';
    end if;
    continue when kind = 'user' and principal = vault_owner;
    if kind = 'user' and not exists (
      select 1 from core."user" u where u.id = principal and u.kind = 'member') then
      raise exception 'guests reach vaults through a Space' using errcode = '22023';
    end if;
    if kind = 'user' and not content.user_can_access_matter(principal, vault_matter) then
      denied := denied || principal;
      continue;
    end if;
    if kind = 'group' then
      denied := denied || coalesce((
        select array_agg(m.user_id) from core.group_member m
         where m.group_id = principal and m.workspace_id = ws
           and not content.user_can_access_matter(m.user_id, vault_matter)), '{}');
    end if;
    insert into core.share_grant
      (workspace_id, object_type, object_id, principal_type, principal_id, level, granted_by)
    values (ws, 'vault', p_vault, kind, principal, lvl, me)
    on conflict do nothing;
  end loop;
  if p_workspace_view then
    insert into core.share_grant
      (workspace_id, object_type, object_id, principal_type, principal_id, level, granted_by)
    values (ws, 'vault', p_vault, 'workspace', ws, 'view', me);
  end if;
  return jsonb_build_object('denied_by_wall', to_jsonb(denied));
end
$$;

create function content.vault_shares(p_vault uuid)
returns table (principal_type text, principal_id uuid, level text, name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform content.require_level(p_vault, array['owner', 'full']);
  return query
    select g.principal_type, g.principal_id, g.level,
           coalesce(u.email, gr.name, 'Everyone in the workspace')
      from core.share_grant g
      left join core."user" u on g.principal_type = 'user' and u.id = g.principal_id
      left join core."group" gr on g.principal_type = 'group' and gr.id = g.principal_id
     where g.object_type = 'vault' and g.object_id = p_vault
     order by 4;
end
$$;

-- Totals count every live file, including ones hidden from the caller by a wall.
create function content.vault_usage(p_vault uuid)
returns table (files bigint, bytes bigint, hidden bigint, max_files bigint, max_bytes bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  reachable uuid[] := content.accessible_matters();
begin
  perform content.require_level(p_vault, array['owner', 'full', 'edit', 'view']);
  return query
    select count(d.id), coalesce(sum(d.size), 0)::bigint,
           count(d.id) filter (where d.matter_id is not null
                                 and not (d.matter_id = any (reachable))),
           least(100000, coalesce((w.settings #>> '{vault_limits,files}')::bigint, 100000)),
           least(107374182400,
                 coalesce((w.settings #>> '{vault_limits,bytes}')::bigint, 107374182400))
      from core.workspace w
      left join content.document d on d.vault_id = p_vault and d.deleted_at is null
     where w.id = core.current_workspace_id()
     group by w.settings;
end
$$;

-- Locks the vault until the upload commits, so two uploads can't both take the last room.
create function content.claim_vault_room(p_vault uuid, p_files integer, p_bytes bigint)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  u record;
begin
  perform content.require_level(p_vault, array['owner', 'full', 'edit']);
  perform 1 from content.vault v where v.id = p_vault for update;
  select * into u from content.vault_usage(p_vault);
  if u.files + p_files > u.max_files then
    return 'VAULT_FILE_LIMIT';
  end if;
  if u.bytes + p_bytes > u.max_bytes then
    return 'VAULT_SIZE_LIMIT';
  end if;
  return null;
end
$$;

-- Totals for the admin list, which covers vaults the admin can't open.
create function content.admin_vault_stats()
returns table (vault_id uuid, files bigint, bytes bigint, grants bigint, owner_email text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not core.has_permission('admin.config') then
    raise exception 'only an admin can list every vault' using errcode = '42501';
  end if;
  return query
    select v.id,
           (select count(*) from content.document d
             where d.vault_id = v.id and d.deleted_at is null),
           (select coalesce(sum(d.size), 0)::bigint from content.document d
             where d.vault_id = v.id and d.deleted_at is null),
           (select count(*) from core.share_grant g
             where g.object_type = 'vault' and g.object_id = v.id),
           u.email
      from content.vault v join core."user" u on u.id = v.owner_id
     where v.workspace_id = core.current_workspace_id();
end
$$;

-- People and groups to share with: active members by email, and groups the caller can see.
create function content.find_principals(p_query text)
returns table (principal_type text, principal_id uuid, label text)
language sql stable security definer set search_path = '' as $$
  select * from (
    select 'user'::text, u.id, u.email from core."user" u
     where u.workspace_id = core.current_workspace_id() and core.is_active_member()
       and u.status = 'active' and u.kind = 'member'
       and strpos(lower(u.email), lower(p_query)) > 0
    union all
    select 'group'::text, g.id, g.name from core."group" g
     where g.workspace_id = core.current_workspace_id() and core.is_active_member()
       and (g.visibility = 'public' or core.is_group_member(g.id))
       and strpos(lower(g.name), lower(p_query)) > 0
  ) found
  order by 3 limit 20
$$;

alter function content.find_principals(text) owner to legallabs_definer;
alter function content.admin_vault_stats() owner to legallabs_definer;
alter function content.require_level(uuid, text[]) owner to legallabs_definer;
alter function content.user_can_access_matter(uuid, uuid) owner to legallabs_definer;
alter function content.trash_items(uuid, uuid[], uuid[]) owner to legallabs_definer;
alter function content.restore_items(uuid, uuid[], uuid[]) owner to legallabs_definer;
alter function content.vault_bin(uuid) owner to legallabs_definer;
alter function content.trash_vault(uuid) owner to legallabs_definer;
alter function content.restore_vault(uuid) owner to legallabs_definer;
alter function content.purge(uuid, uuid[], uuid[], uuid[]) owner to legallabs_definer;
alter function content.purge_vault(uuid) owner to legallabs_definer;
alter function content.transfer_vault(uuid, uuid) owner to legallabs_definer;
alter function content.set_vault_shares(uuid, jsonb, boolean) owner to legallabs_definer;
alter function content.vault_shares(uuid) owner to legallabs_definer;
alter function content.vault_usage(uuid) owner to legallabs_definer;
alter function content.claim_vault_room(uuid, integer, bigint) owner to legallabs_definer;

revoke execute on all functions in schema content from public;
grant execute on function content.require_level(uuid, text[]),
  content.user_can_access_matter(uuid, uuid), content.vault_usage(uuid),
  content.purge(uuid, uuid[], uuid[], uuid[])
  to legallabs_definer;
grant execute on function content.trash_items(uuid, uuid[], uuid[]),
  content.restore_items(uuid, uuid[], uuid[]), content.vault_bin(uuid),
  content.trash_vault(uuid), content.restore_vault(uuid), content.purge_vault(uuid),
  content.transfer_vault(uuid, uuid), content.set_vault_shares(uuid, jsonb, boolean),
  content.vault_shares(uuid), content.vault_usage(uuid),
  content.claim_vault_room(uuid, integer, bigint), content.admin_vault_stats(),
  content.find_principals(text)
  to legallabs_app;
