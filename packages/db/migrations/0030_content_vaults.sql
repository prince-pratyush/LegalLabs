-- A vault holds the documents for one piece of work and is shared as a unit.
create table content.vault (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  owner_id uuid not null,
  matter_id uuid,
  name text not null check (char_length(name) between 1 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  content_controls jsonb not null
    default '{"allow_download": true, "allow_duplicate": true, "show_review_prompts": true}',
  retention_hours integer check (retention_hours >= 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  unique (workspace_id, id),
  check ((deleted_at is null) = (deleted_by is null)),
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id),
  foreign key (workspace_id, matter_id) references core.matter (workspace_id, id),
  foreign key (workspace_id, deleted_by) references core."user" (workspace_id, id)
);
create index vault_owner_idx on content.vault (workspace_id, owner_id);

create table content.folder (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  vault_id uuid not null,
  parent_id uuid check (parent_id <> id),
  name text not null check (char_length(name) between 1 and 255),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  unique (workspace_id, id),
  unique (vault_id, id),
  check ((deleted_at is null) = (deleted_by is null)),
  foreign key (workspace_id, vault_id) references content.vault (workspace_id, id) on delete cascade,
  -- Through the vault, so a folder can never hang under another vault's tree.
  foreign key (vault_id, parent_id) references content.folder (vault_id, id) on delete cascade,
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id),
  foreign key (workspace_id, deleted_by) references core."user" (workspace_id, id)
);
-- One live folder per name in a place, so parallel uploads of a folder share it.
create unique index folder_name_idx on content.folder
  (vault_id, coalesce(parent_id, vault_id), lower(name)) where deleted_at is null;
create index folder_children_idx on content.folder (vault_id, parent_id, lower(name))
  where deleted_at is null;

-- A document outside a vault stays private to its owner, as before.
alter table content.document
  add column vault_id uuid,
  add column folder_id uuid,
  add column updated_at timestamptz not null default now(),
  add column deleted_at timestamptz,
  add column deleted_by uuid,
  add column deleted_reason text check (deleted_reason in ('user', 'retention')),
  add check (folder_id is null or vault_id is not null),
  add check ((deleted_at is null) = (deleted_reason is null)),
  add foreign key (workspace_id, vault_id) references content.vault (workspace_id, id)
    on delete cascade,
  add foreign key (vault_id, folder_id) references content.folder (vault_id, id)
    on delete cascade;
create index document_tree_idx on content.document (vault_id, folder_id, lower(name), id)
  where vault_id is not null and deleted_at is null;
create index document_bin_idx on content.document (vault_id, deleted_at)
  where deleted_at is not null;

alter table content.vault enable row level security;
alter table content.vault force row level security;
alter table content.folder enable row level security;
alter table content.folder force row level security;

grant select on content.vault, content.folder to legallabs_definer;
create policy definer_read on content.vault for select to legallabs_definer using (true);
create policy definer_read on content.folder for select to legallabs_definer using (true);

-- A move into a binned folder would hide a live file, then purge it along with the folder.
-- A function, not a subquery: a policy on folder can't query folder (see parent_fits).
create function content.folder_live(p_folder uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return p_folder is null or exists (
    select 1 from content.folder f where f.id = p_folder and f.deleted_at is null);
end
$$;
alter function content.folder_live(uuid) owner to legallabs_definer;
grant execute on function content.folder_live(uuid) to legallabs_app;

-- Guests reach vaults only through a Space, never by a direct grant or a group.
create function content.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core."user" u
                  where u.id = core.current_user_id() and u.kind = 'member')
$$;
alter function content.is_member() owner to legallabs_definer;
grant execute on function content.is_member() to legallabs_app, legallabs_definer;

-- Every open vault the caller reaches at a level, past the vault's wall. Policies call it as
-- (select ...), so it runs once per statement instead of once per row.
create function content.readable_vaults(min_level text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(v.id), '{}')
    from content.vault v
   where v.workspace_id = core.current_workspace_id()
     and core.is_active_member()
     and content.is_member()
     and v.deleted_at is null
     and core.can_access_matter(v.matter_id)
     and (v.owner_id = core.current_user_id() or core.has_access('vault', v.id, min_level))
$$;

-- The caller's level on one vault: owner, full, edit, view, or null.
create function content.vault_level(p_vault uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when v.owner_id = core.current_user_id() then 'owner'
    when core.has_access('vault', v.id, 'full') then 'full'
    when core.has_access('vault', v.id, 'edit') then 'edit'
    when core.has_access('vault', v.id, 'view') then 'view'
  end
    from content.vault v
   where v.id = p_vault
     and v.workspace_id = core.current_workspace_id()
     and core.is_active_member()
     and content.is_member()
     and v.deleted_at is null
     and core.can_access_matter(v.matter_id)
$$;

-- Every matter the caller's walls let them into. Policies compare against this list, worked
-- out once per statement, instead of checking the walls again for each of thousands of rows.
create function content.accessible_matters() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(mt.id), '{}')
    from core.matter mt
   where mt.workspace_id = core.current_workspace_id()
     and core.can_access_matter(mt.id)
$$;

alter function content.accessible_matters() owner to legallabs_definer;
grant execute on function content.accessible_matters() to legallabs_app, legallabs_definer;
alter function content.readable_vaults(text) owner to legallabs_definer;
alter function content.vault_level(uuid) owner to legallabs_definer;
grant execute on function content.readable_vaults(text), content.vault_level(uuid)
  to legallabs_app, legallabs_definer;

-- Admins see every vault's details for the admin list, never its documents.
grant select, insert on content.vault to legallabs_app;
grant update (name, description, content_controls, retention_hours, updated_at)
  on content.vault to legallabs_app;
create policy vault_read on content.vault for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and core.can_access_matter(matter_id)
         and (owner_id = core.current_user_id()
              or (deleted_at is null and content.is_member()
                  and core.has_access('vault', id, 'view'))
              or core.has_permission('admin.config')));
create policy vault_insert on content.vault for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and owner_id = core.current_user_id()
              and deleted_at is null
              and core.has_permission('vaults.create')
              and core.can_access_matter(matter_id));
create policy vault_update on content.vault for update to legallabs_app
  using (core.in_tenant(workspace_id) and content.vault_level(id) in ('owner', 'full'))
  with check (core.in_tenant(workspace_id) and content.vault_level(id) in ('owner', 'full'));

grant select, insert on content.folder to legallabs_app;
grant update (name, parent_id) on content.folder to legallabs_app;
create policy folder_read on content.folder for select to legallabs_app
  using (core.in_tenant(workspace_id) and deleted_at is null
         and vault_id = any ((select content.readable_vaults('view'))::uuid[]));
create policy folder_insert on content.folder for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and deleted_at is null
              and created_by = core.current_user_id()
              and vault_id = any ((select content.readable_vaults('edit'))::uuid[]));
create policy folder_update on content.folder for update to legallabs_app
  using (core.in_tenant(workspace_id) and deleted_at is null
         and vault_id = any ((select content.readable_vaults('edit'))::uuid[]))
  with check (core.in_tenant(workspace_id)
              and vault_id = any ((select content.readable_vaults('edit'))::uuid[])
              and content.folder_live(parent_id));

-- A move must not put a folder inside itself.
create function content.check_folder_cycle() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.parent_id is not null and exists (
    with recursive up as (
      select f.id, f.parent_id from content.folder f where f.id = new.parent_id
      union all
      select f.id, f.parent_id from content.folder f join up on f.id = up.parent_id
    ) select 1 from up where up.id = new.id)
  then
    raise exception 'a folder cannot move inside itself' using errcode = '23514';
  end if;
  return new;
end
$$;
alter function content.check_folder_cycle() owner to legallabs_definer;
create trigger folder_cycle before update of parent_id on content.folder
  for each row execute function content.check_folder_cycle();

-- Who sees a document: its owner outside a vault, or anyone the vault lets in. Walls still
-- apply per document, and the recycle bin is out of sight until restored.
drop policy document_read on content.document;
create policy document_read on content.document for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and deleted_at is null
         and (matter_id is null
              or matter_id = any ((select content.accessible_matters())::uuid[]))
         and case when vault_id is null then owner_id = core.current_user_id()
                  else vault_id = any ((select content.readable_vaults('view'))::uuid[]) end);

-- Run as the caller, so the parent must be one they can see. A function, not a subquery: a
-- policy on document can't query document once the read policy holds a subquery.
create function content.parent_fits(p_parent uuid, p_matter uuid, p_vault uuid) returns boolean
language plpgsql stable set search_path = '' as $$
begin
  return exists (select 1 from content.document p
                  where p.id = p_parent
                    and p.matter_id is not distinct from p_matter
                    and p.vault_id is not distinct from p_vault);
end
$$;
grant execute on function content.parent_fits(uuid, uuid, uuid) to legallabs_app;

-- A document in a matter vault stays on that matter, so it can't step outside the wall.
drop policy document_insert on content.document;
create policy document_insert on content.document for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and owner_id = core.current_user_id()
              and deleted_at is null
              and core.can_access_matter(matter_id)
              and core.has_permission('threads.use')
              and (parent_id is null or content.parent_fits(parent_id, matter_id, vault_id))
              and (vault_id is null or (
                vault_id = any ((select content.readable_vaults('edit'))::uuid[])
                and exists (select 1 from content.vault v
                             where v.id = document.vault_id
                               and (v.matter_id is null
                                    or v.matter_id = document.matter_id)))));

-- Renames and moves only: the text a citation was checked against never changes.
grant update (name, folder_id, updated_at) on content.document to legallabs_app;
create policy document_update on content.document for update to legallabs_app
  using (core.in_tenant(workspace_id) and deleted_at is null
         and vault_id = any ((select content.readable_vaults('edit'))::uuid[]))
  with check (core.in_tenant(workspace_id)
              and vault_id = any ((select content.readable_vaults('edit'))::uuid[])
              and content.folder_live(folder_id));

revoke execute on all functions in schema content from public;
