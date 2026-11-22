-- A synced vault mirrors one provider folder, one way. `change_token` is the Drive changes
-- page token or the Graph delta link; `sync_item` maps each remote id to its vault row so a
-- rename or move keeps the document id and a deletion finds what to put in the bin.
create table content.vault_sync (
  vault_id uuid primary key,
  workspace_id uuid not null,
  connection_id uuid not null,
  provider text not null check (provider in ('google_drive', 'sharepoint')),
  drive_id text,
  root_remote_id text not null,
  root_name text not null default '',
  change_token text,
  cadence_minutes integer not null default 60 check (cadence_minutes in (15, 60, 1440)),
  status text not null default 'pending'
    check (status in ('pending', 'syncing', 'ok', 'sync_error')),
  last_attempt_at timestamptz,
  last_sync_at timestamptz,
  last_error_code text,
  last_error text,
  last_counts jsonb not null default '{}',
  next_run_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, vault_id) references content.vault (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, connection_id) references content.sync_connection (workspace_id, id)
);
create index vault_sync_due_idx on content.vault_sync (next_run_at);

create table content.sync_item (
  vault_id uuid not null,
  remote_id text not null check (char_length(remote_id) between 1 and 512),
  workspace_id uuid not null,
  kind text not null check (kind in ('folder', 'file')),
  parent_remote_id text,
  name text not null,
  document_id uuid,
  folder_id uuid,
  remote_version text,
  state text not null default 'synced' check (state in ('synced', 'skipped', 'failed')),
  skip_reason text,
  primary key (vault_id, remote_id),
  foreign key (vault_id) references content.vault_sync (vault_id) on delete cascade,
  foreign key (document_id) references content.document (id) on delete set null,
  foreign key (folder_id) references content.folder (id) on delete set null
);
create index sync_item_parent_idx on content.sync_item (vault_id, parent_remote_id);

alter table content.vault_sync enable row level security;
alter table content.vault_sync force row level security;
alter table content.sync_item enable row level security;
alter table content.sync_item force row level security;
grant select, insert, delete on content.vault_sync, content.sync_item to legallabs_app;
grant update on content.vault_sync, content.sync_item to legallabs_app;

-- Anyone who can open the vault sees its status; only its owner links, changes or runs it.
create policy vault_sync_read on content.vault_sync for select to legallabs_app
  using (core.in_tenant(workspace_id) and content.vault_level(vault_id) is not null);
create policy vault_sync_write on content.vault_sync for all to legallabs_app
  using (core.in_tenant(workspace_id) and content.vault_level(vault_id) = 'owner')
  with check (core.in_tenant(workspace_id) and content.vault_level(vault_id) = 'owner');
create policy sync_item_owner on content.sync_item for all to legallabs_app
  using (core.in_tenant(workspace_id) and content.vault_level(vault_id) = 'owner')
  with check (core.in_tenant(workspace_id) and content.vault_level(vault_id) = 'owner');

-- The scheduler lists vaults that are due, across workspaces, without a person's identity.
create function content.due_vault_syncs(p_limit integer)
returns table (vault_id uuid, workspace_id uuid, owner_id uuid)
language sql security definer set search_path = '' as $$
  select s.vault_id, s.workspace_id, v.owner_id
    from content.vault_sync s join content.vault v on v.id = s.vault_id
   where v.deleted_at is null and s.next_run_at <= now() and s.status <> 'syncing'
   order by s.next_run_at limit greatest(p_limit, 0)
$$;
alter function content.due_vault_syncs(integer) owner to legallabs_definer;
grant select on content.vault_sync to legallabs_definer;
create policy vault_sync_definer on content.vault_sync for select to legallabs_definer
  using (true);
revoke execute on function content.due_vault_syncs(integer) from public;
grant execute on function content.due_vault_syncs(integer) to legallabs_worker;

-- A synced vault is read-only: people cannot add, rename, move or bin anything in it. The
-- sync engine's own pool starts its sessions with legallabs.sync_writer = on. Retention's
-- sweep still bins files (reason 'retention'), and purging a bin still deletes rows.
create function content.guard_synced_vault() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  vid uuid := coalesce(new.vault_id, old.vault_id);
  changed boolean;
begin
  if vid is null or current_setting('legallabs.sync_writer', true) = 'on' then
    return new;
  end if;
  if not exists (select 1 from content.vault_sync s where s.vault_id = vid) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    changed := true;
  elsif tg_table_name = 'document' then
    changed := new.name is distinct from old.name
      or new.folder_id is distinct from old.folder_id
      or (new.deleted_at is distinct from old.deleted_at
          and 'retention' is distinct from new.deleted_reason
          and 'retention' is distinct from old.deleted_reason);
  else
    changed := new.name is distinct from old.name
      or new.parent_id is distinct from old.parent_id
      or new.deleted_at is distinct from old.deleted_at;
  end if;
  if changed then
    raise exception 'VAULT_READ_ONLY' using errcode = 'P0001';
  end if;
  return new;
end
$$;
alter function content.guard_synced_vault() owner to legallabs_definer;
grant select on content.vault_sync to legallabs_definer;
create trigger document_synced_guard before insert or update on content.document
  for each row execute function content.guard_synced_vault();
create trigger folder_synced_guard before insert or update on content.folder
  for each row execute function content.guard_synced_vault();
