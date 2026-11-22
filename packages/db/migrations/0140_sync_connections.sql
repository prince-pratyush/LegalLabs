-- Drive and SharePoint sync (CON-002). A person links their own account; the OAuth tokens
-- are sealed in admin.secret like a provider key, and the connection keeps only the reference.
-- Not exercised against a live Google or Microsoft tenant: UNVERIFIED, see docs/connectors.
create table content.sync_connection (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  user_id uuid not null,
  provider text not null check (provider in ('google_drive', 'sharepoint')),
  account_label text not null default '' check (char_length(account_label) <= 320),
  secret_ref text not null,
  status text not null default 'active' check (status in ('active', 'needs_reauth', 'revoked')),
  status_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade,
  foreign key (workspace_id, secret_ref) references admin.secret (workspace_id, id)
);

alter table content.sync_connection enable row level security;
alter table content.sync_connection force row level security;
grant select, insert, delete on content.sync_connection to legallabs_app;
grant update (account_label, status, status_detail, updated_at)
  on content.sync_connection to legallabs_app;
create policy sync_connection_own on content.sync_connection for all to legallabs_app
  using (core.in_tenant(workspace_id) and user_id = core.current_user_id())
  with check (core.in_tenant(workspace_id) and user_id = core.current_user_id());

-- A person who is not an admin may still seal their own token: the one write path into
-- admin.secret that skips the admin policy, and only for the caller's workspace.
grant insert on admin.secret to legallabs_definer;
create policy secret_definer_insert on admin.secret for insert to legallabs_definer
  with check (true);
create function content.store_sync_secret(p_ref text, p_ciphertext bytea) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if core.current_user_id() is null or not content.is_member() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into admin.secret (id, workspace_id, ciphertext)
  values (p_ref, core.current_workspace_id(), p_ciphertext);
end
$$;
alter function content.store_sync_secret(text, bytea) owner to legallabs_definer;
revoke execute on function content.store_sync_secret(text, bytea) from public;
grant execute on function content.store_sync_secret(text, bytea) to legallabs_app;

-- The sync worker swaps in refreshed tokens in place.
grant update (ciphertext) on admin.secret to legallabs_definer;
create policy secret_definer_update on admin.secret for update to legallabs_definer
  using (true) with check (true);
create function content.rotate_sync_secret(p_workspace uuid, p_ref text, p_ciphertext bytea)
returns void
language sql security definer set search_path = '' as $$
  update admin.secret set ciphertext = p_ciphertext
   where workspace_id = p_workspace and id = p_ref
     and exists (select 1 from content.sync_connection c
                  where c.workspace_id = p_workspace and c.secret_ref = p_ref)
$$;
alter function content.rotate_sync_secret(uuid, text, bytea) owner to legallabs_definer;
revoke execute on function content.rotate_sync_secret(uuid, text, bytea) from public;
grant execute on function content.rotate_sync_secret(uuid, text, bytea) to legallabs_worker;

-- Connections the worker may mark broken (revoked access) without a person's identity.
create function content.sync_connection_state(p_workspace uuid, p_id uuid, p_status text,
                                              p_detail text) returns void
language sql security definer set search_path = '' as $$
  update content.sync_connection set status = p_status, status_detail = p_detail, updated_at = now()
   where workspace_id = p_workspace and id = p_id
$$;
alter function content.sync_connection_state(uuid, uuid, text, text) owner to legallabs_definer;
revoke execute on function content.sync_connection_state(uuid, uuid, text, text) from public;
grant execute on function content.sync_connection_state(uuid, uuid, text, text)
  to legallabs_worker;
grant update (status, status_detail, updated_at) on content.sync_connection to legallabs_definer;
grant select on content.sync_connection to legallabs_definer;
create policy sync_connection_definer on content.sync_connection for all to legallabs_definer
  using (true) with check (true);

-- Unlinking removes the connection and its sealed tokens together. A connection still used
-- by a synced vault stays: the vault would stop syncing without anyone being told.
create function content.unlink_sync_connection(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  ref text;
begin
  select c.secret_ref into ref from content.sync_connection c
   where c.id = p_id and c.workspace_id = core.current_workspace_id()
     and c.user_id = core.current_user_id();
  if ref is null then return false; end if;
  if to_regclass('content.vault_sync') is not null and exists (
       select 1 from content.vault_sync s where s.connection_id = p_id) then
    return false;
  end if;
  delete from content.sync_connection where id = p_id;
  delete from admin.secret where id = ref and workspace_id = core.current_workspace_id();
  return true;
end
$$;
alter function content.unlink_sync_connection(uuid) owner to legallabs_definer;
revoke execute on function content.unlink_sync_connection(uuid) from public;
grant execute on function content.unlink_sync_connection(uuid) to legallabs_app;
grant delete on content.sync_connection, admin.secret to legallabs_definer;
create policy secret_definer_delete on admin.secret for delete to legallabs_definer using (true);
