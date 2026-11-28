-- Managing people from the app: rules the database keeps whichever route is used, and
-- single-use links with which an invited person sets their first password.

-- As before (0105), with two more rules for an administrator's change: nobody may touch someone
-- holding more than they do, and what an identity provider owns stays the provider's.
create or replace function core.guard_user() returns trigger
language plpgsql as $$
begin
  -- Migrations and maintenance run as the owner; only app requests are limited.
  if current_user <> 'legallabs_app' then
    return new;
  end if;
  if scim.is_principal() then
    if tg_op = 'INSERT' then
      if new.kind <> 'member' or new.role_id is not null or new.extra_permissions <> '{}' then
        raise exception 'SCIM cannot set access' using errcode = 'insufficient_privilege';
      end if;
    elsif (new.kind, new.role_id, new.extra_permissions, new.role_from_group)
          is distinct from (old.kind, old.role_id, old.extra_permissions, old.role_from_group) then
      raise exception 'SCIM cannot set access' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.kind is distinct from old.kind then
      raise exception 'kind cannot change' using errcode = 'check_violation';
    end if;
    if new.id = core.current_user_id()
       and (new.role_id, new.extra_permissions, new.status)
           is distinct from (old.role_id, old.extra_permissions, old.status) then
      raise exception 'nobody can change their own access' using errcode = 'insufficient_privilege';
    end if;
    if (new.role_id, new.extra_permissions, new.status)
       is not distinct from (old.role_id, old.extra_permissions, old.status) then
      return new;
    end if;
    if old.scim_managed and (new.status is distinct from old.status
         or (old.role_from_group and new.role_id is distinct from old.role_id)) then
      raise exception 'SCIM_MANAGED' using errcode = 'check_violation';
    end if;
    if not core.holds_all(core.role_permissions(old.role_id) || old.extra_permissions) then
      raise exception 'cannot manage someone with permissions you do not hold'
        using errcode = 'insufficient_privilege';
    end if;
    if (new.role_id, new.extra_permissions) is not distinct from (old.role_id, old.extra_permissions) then
      return new;
    end if;
  end if;
  if not core.holds_all(core.role_permissions(new.role_id) || new.extra_permissions) then
    raise exception 'cannot grant permissions you do not hold' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;

-- A workspace always keeps one active administrator. Keyed on the role the transaction took
-- (SET ROLE), which stays visible inside definer functions, so no request path is exempt while
-- the owner's maintenance is.
create function core.keep_last_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('role', true) is distinct from 'legallabs_app' then
    return new;
  end if;
  if old.kind <> 'member' or old.status <> 'active'
     or not coalesce('*' = any (core.role_permissions(old.role_id)), false) then
    return new;
  end if;
  if new.status = 'active' and coalesce('*' = any (core.role_permissions(new.role_id)), false) then
    return new;
  end if;
  -- One change at a time, or two administrators could remove each other at once.
  perform pg_advisory_xact_lock(hashtextextended('last_admin:' || old.workspace_id::text, 0));
  if not exists (
    select 1 from core."user" u
      join core.role r on r.workspace_id = u.workspace_id and r.id = u.role_id
     where u.workspace_id = old.workspace_id and u.id <> old.id and u.kind = 'member'
       and u.status = 'active' and '*' = any (r.permissions)) then
    raise exception 'LAST_ADMIN' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function core.keep_last_admin() owner to legallabs_definer;
grant execute on function core.role_permissions(uuid) to legallabs_definer;
create trigger user_keep_last_admin before update on core."user"
  for each row execute function core.keep_last_admin();

-- The built-in Admin role is what the rule above counts, so no request may change it.
create function core.keep_admin_role() returns trigger
language plpgsql as $$
begin
  if current_user = 'legallabs_app' and old.builtin and old.name = 'Admin' then
    if tg_op = 'DELETE' or (new.permissions, new.name, new.builtin)
       is distinct from (old.permissions, old.name, old.builtin) then
      raise exception 'the built-in Admin role cannot be changed'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
create trigger role_keep_admin before update or delete on core.role
  for each row execute function core.keep_admin_role();

-- Single use, short lived, and only the hash is kept. The app role has no grant at all: the
-- functions below are the only way in.
create table core.user_invite (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  user_id uuid not null,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  -- The role the invitation was made for: a link dies if the person's role changes.
  role_id uuid,
  invited_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null check (expires_at <= created_at + interval '7 days'),
  used_at timestamptz,
  revoked_at timestamptz,
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);
create index user_invite_user_idx on core.user_invite (workspace_id, user_id);

alter table core.user_invite enable row level security;
alter table core.user_invite force row level security;
grant select, insert, update, delete on core.user_invite to legallabs_definer;
create policy definer_all on core.user_invite for all to legallabs_definer
  using (true) with check (true);

grant insert, update on core.password_credential to legallabs_definer;
create policy definer_insert on core.password_credential for insert to legallabs_definer
  with check (true);
create policy definer_update on core.password_credential for update to legallabs_definer
  using (true) with check (true);

create function core.role_is_admin(p_permissions text[]) returns boolean
language sql immutable set search_path = '' as $$
  select exists (select 1 from unnest(p_permissions) p
                  where p = '*' or p like 'admin.%' or p = 'api.service_accounts')
$$;
grant execute on function core.role_is_admin(text[]) to legallabs_app, legallabs_definer;

create function core.create_invite(p_user uuid, p_token_hash bytea, p_ttl_seconds integer)
returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  target core."user";
  perms text[];
  until timestamptz;
begin
  if not coalesce(core.in_tenant(ws) and core.has_permission('admin.users'), false) then
    raise exception 'not allowed to invite people' using errcode = '42501';
  end if;
  select * into target from core."user" u
   where u.workspace_id = ws and u.id = p_user and u.kind = 'member' and u.status = 'invited'
     and not u.scim_managed;
  if not found then
    raise exception 'this person cannot be invited' using errcode = '22023';
  end if;
  perms := core.role_permissions(target.role_id) || target.extra_permissions;
  if core.role_is_admin(perms) then
    raise exception 'an administrator cannot be invited by link' using errcode = '22023';
  end if;
  if not core.holds_all(perms) then
    raise exception 'cannot grant permissions you do not hold' using errcode = '42501';
  end if;
  if p_ttl_seconds not between 60 and 604800 then
    raise exception 'invitation lifetime out of range' using errcode = '22023';
  end if;
  update core.user_invite i set revoked_at = now()
   where i.workspace_id = ws and i.user_id = p_user and i.used_at is null and i.revoked_at is null;
  insert into core.user_invite (workspace_id, user_id, token_hash, role_id, invited_by, expires_at)
  values (ws, p_user, p_token_hash, target.role_id, core.current_user_id(),
          now() + make_interval(secs => p_ttl_seconds))
  returning expires_at into until;
  return until;
end
$$;

create function core.revoke_invites(p_user uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  n integer;
begin
  if not coalesce(core.in_tenant(ws) and core.has_permission('admin.users'), false) then
    raise exception 'not allowed to manage invitations' using errcode = '42501';
  end if;
  update core.user_invite i set revoked_at = now()
   where i.workspace_id = ws and i.user_id = p_user and i.used_at is null and i.revoked_at is null;
  get diagnostics n = row_count;
  return n;
end
$$;

-- Whether someone has ever had a way to sign in, to say what reactivating should return them to.
create function core.user_can_sign_in(p_user uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
begin
  if not coalesce(core.in_tenant(ws) and core.has_permission('admin.users'), false) then
    raise exception 'not allowed to manage people' using errcode = '42501';
  end if;
  return exists (select 1 from core.password_credential c
                  where c.workspace_id = ws and c.user_id = p_user)
      or exists (select 1 from core.external_identity e
                  where e.workspace_id = ws and e.user_id = p_user);
end
$$;

-- Runs before anyone is signed in. Every reason to refuse answers the same: no rows.
create function core.accept_invite(p_token_hash bytea, p_password_hash text)
returns table (workspace_id uuid, user_id uuid, email text, workspace_slug text)
language plpgsql security definer set search_path = '' as $$
declare
  invite core.user_invite;
  target core."user";
begin
  select * into invite from core.user_invite i
   where i.token_hash = p_token_hash and i.used_at is null and i.revoked_at is null
     and i.expires_at > now()
   for update;
  if not found then
    return;
  end if;
  select * into target from core."user" u
   where u.workspace_id = invite.workspace_id and u.id = invite.user_id for update;
  if target.status <> 'invited' or target.kind <> 'member' or target.scim_managed
     or target.role_id is distinct from invite.role_id or target.extra_permissions <> '{}'
     or core.role_is_admin(core.role_permissions(target.role_id)) then
    return;
  end if;
  -- With single sign-on or SCIM on, a password is no longer how members get in.
  if exists (select 1 from core.oidc_provider p
              where p.workspace_id = invite.workspace_id and p.enabled)
     or exists (select 1 from core.workspace w
                 where w.id = invite.workspace_id and w.settings ->> 'scim_enabled' = 'true') then
    return;
  end if;
  update core.user_invite i set used_at = now() where i.id = invite.id;
  insert into core.password_credential as c (workspace_id, user_id, password_hash)
  values (invite.workspace_id, invite.user_id, p_password_hash)
  on conflict on constraint password_credential_pkey do update
    set password_hash = excluded.password_hash, updated_at = now();
  update core."user" u set status = 'active'
   where u.workspace_id = invite.workspace_id and u.id = invite.user_id;
  return query
    select invite.workspace_id, invite.user_id, target.email, w.slug
      from core.workspace w where w.id = invite.workspace_id;
end
$$;

alter function core.create_invite(uuid, bytea, integer) owner to legallabs_definer;
alter function core.revoke_invites(uuid) owner to legallabs_definer;
alter function core.user_can_sign_in(uuid) owner to legallabs_definer;
alter function core.accept_invite(bytea, text) owner to legallabs_definer;
grant execute on function core.create_invite(uuid, bytea, integer), core.revoke_invites(uuid),
  core.user_can_sign_in(uuid), core.accept_invite(bytea, text) to legallabs_app;
grant execute on function core.holds_all(text[]), core.current_user_id(),
  core.current_workspace_id() to legallabs_definer;
