-- Passkeys. Like the authenticator secret, these rows are reached only through the functions
-- below; a public key is no secret, but a counter or a credential must not be editable by the app.
create table core.mfa_passkey (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  user_id uuid not null,
  credential_id text not null check (char_length(credential_id) between 1 and 1024),
  public_key bytea not null,
  counter bigint not null default 0 check (counter >= 0),
  transports text[] not null default '{}',
  name text not null check (char_length(name) between 1 and 100),
  device_type text not null default 'singleDevice',
  backed_up boolean not null default false,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (workspace_id, credential_id),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);
create index mfa_passkey_user_idx on core.mfa_passkey (workspace_id, user_id);

-- A challenge is answered once, soon, for the one thing it was made for.
create table core.mfa_challenge (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  -- Empty for a passkey-first sign-in, where nobody is known yet.
  user_id uuid,
  purpose text not null check (purpose in ('register', 'authenticate')),
  challenge text not null,
  expires_at timestamptz not null
);
create index mfa_challenge_expiry_idx on core.mfa_challenge (expires_at);

grant select, insert, update, delete on core.mfa_passkey, core.mfa_challenge to legallabs_definer;
alter table core.mfa_passkey enable row level security;
alter table core.mfa_passkey force row level security;
alter table core.mfa_challenge enable row level security;
alter table core.mfa_challenge force row level security;
create policy definer_all on core.mfa_passkey for all to legallabs_definer using (true) with check (true);
create policy definer_all on core.mfa_challenge for all to legallabs_definer using (true) with check (true);

create function core.mfa_passkey_add(
  p_credential_id text, p_public_key bytea, p_counter bigint, p_transports text[], p_name text,
  p_device_type text, p_backed_up boolean
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
begin
  if not core.is_active_member() then
    raise exception 'not an active member' using errcode = '42501';
  end if;
  insert into core.mfa_passkey (workspace_id, user_id, credential_id, public_key, counter,
                                transports, name, device_type, backed_up)
  values (core.current_workspace_id(), core.current_user_id(), p_credential_id, p_public_key,
          p_counter, p_transports, p_name, p_device_type, p_backed_up)
  returning id into new_id;
  return new_id;
end
$$;

create function core.mfa_passkey_list()
returns table (id uuid, credential_id text, transports text[], name text, backed_up boolean,
               created_at timestamptz, last_used_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select k.id, k.credential_id, k.transports, k.name, k.backed_up, k.created_at, k.last_used_at
    from core.mfa_passkey k
   where k.workspace_id = core.current_workspace_id()
     and k.user_id = core.current_user_id()
     and core.is_active_member()
   order by k.created_at
$$;

create function core.mfa_passkey_get(p_credential_id text)
returns table (id uuid, public_key bytea, counter bigint, transports text[])
language sql stable security definer set search_path = '' as $$
  select k.id, k.public_key, k.counter, k.transports
    from core.mfa_passkey k
   where k.workspace_id = core.current_workspace_id()
     and k.user_id = core.current_user_id()
     and k.credential_id = p_credential_id
     and core.is_active_member()
$$;

-- Runs before sign-in for a passkey-first login: the signature check is what proves the person.
create function core.mfa_passkey_lookup(p_workspace_slug text, p_credential_id text)
returns table (id uuid, workspace_id uuid, user_id uuid, public_key bytea, counter bigint,
               transports text[], status text, kind text)
language sql stable security definer set search_path = '' as $$
  select k.id, k.workspace_id, k.user_id, k.public_key, k.counter, k.transports, u.status, u.kind
    from core.mfa_passkey k
    join core.workspace w on w.id = k.workspace_id
    join core."user" u on u.workspace_id = k.workspace_id and u.id = k.user_id
   where w.slug = p_workspace_slug and k.credential_id = p_credential_id
$$;

-- A counter that goes backwards means a cloned authenticator; a constant zero is allowed
-- because synced passkeys never count.
create function core.mfa_passkey_touch(p_id uuid, p_counter bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update core.mfa_passkey k
     set counter = greatest(k.counter, p_counter), last_used_at = now()
   where k.id = p_id
     and k.workspace_id = core.current_workspace_id()
     and k.user_id = core.current_user_id()
     and core.is_active_member()
     and (p_counter > k.counter or (p_counter = 0 and k.counter = 0));
  return found;
end
$$;

create function core.mfa_passkey_remove(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from core.mfa_passkey
   where id = p_id
     and workspace_id = core.current_workspace_id()
     and user_id = core.current_user_id()
     and core.is_active_member();
  return found;
end
$$;

-- Callable before sign-in (passkey-first), so a person is not required, only a real workspace.
create function core.mfa_challenge_put(p_purpose text, p_workspace uuid, p_user uuid,
                                       p_challenge text, p_secs integer)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
begin
  if p_secs not between 1 and 600 then
    raise exception 'challenge lifetime out of range' using errcode = '22023';
  end if;
  if p_user is not null
     and (p_user is distinct from core.current_user_id()
          or p_workspace is distinct from core.current_workspace_id()) then
    raise exception 'challenge is for someone else' using errcode = '42501';
  end if;
  delete from core.mfa_challenge where expires_at < now();
  insert into core.mfa_challenge (workspace_id, user_id, purpose, challenge, expires_at)
  values (p_workspace, p_user, p_purpose, p_challenge, now() + make_interval(secs => p_secs))
  returning id into new_id;
  return new_id;
end
$$;

-- Deleting while reading is what makes a challenge single-use.
create function core.mfa_challenge_take(p_id uuid, p_purpose text)
returns table (workspace_id uuid, user_id uuid, challenge text)
language sql security definer set search_path = '' as $$
  delete from core.mfa_challenge c
   where c.id = p_id and c.purpose = p_purpose and c.expires_at > now()
  returning c.workspace_id, c.user_id, c.challenge
$$;

-- Everything the login decision needs, in one read made before there is an identity.
-- 'admins' covers members holding any admin permission; guests are only reached by the last policy.
create function core.mfa_login_state(p_workspace uuid, p_user uuid)
returns table (policy text, required boolean, has_totp boolean, has_passkey boolean)
language sql stable security definer set search_path = '' as $$
  with subject as (
    select coalesce(w.settings ->> 'mfa', 'admins') as policy, u.kind,
           (u.kind = 'member' and (
              '*' = any (u.extra_permissions || coalesce(r.permissions, '{}'))
              or exists (select 1 from unnest(u.extra_permissions || coalesce(r.permissions, '{}')) p
                          where p like 'admin.%'))) as is_admin
      from core.workspace w
      join core."user" u on u.workspace_id = w.id and u.id = p_user
      left join core.role r on r.workspace_id = u.workspace_id and r.id = u.role_id
     where w.id = p_workspace)
  select s.policy,
         case s.policy
           when 'admins' then s.is_admin
           when 'all' then s.kind = 'member'
           when 'all_incl_guests' then s.kind in ('member', 'guest')
           else false
         end,
         exists (select 1 from core.mfa_totp t
                  where t.workspace_id = p_workspace and t.user_id = p_user
                    and t.confirmed_at is not null),
         exists (select 1 from core.mfa_passkey k
                  where k.workspace_id = p_workspace and k.user_id = p_user)
    from subject s
$$;

alter function core.mfa_passkey_add(text, bytea, bigint, text[], text, text, boolean)
  owner to legallabs_definer;
alter function core.mfa_passkey_list() owner to legallabs_definer;
alter function core.mfa_passkey_get(text) owner to legallabs_definer;
alter function core.mfa_passkey_lookup(text, text) owner to legallabs_definer;
alter function core.mfa_passkey_touch(uuid, bigint) owner to legallabs_definer;
alter function core.mfa_passkey_remove(uuid) owner to legallabs_definer;
alter function core.mfa_challenge_put(text, uuid, uuid, text, integer) owner to legallabs_definer;
alter function core.mfa_challenge_take(uuid, text) owner to legallabs_definer;
alter function core.mfa_login_state(uuid, uuid) owner to legallabs_definer;
grant execute on function
  core.mfa_passkey_add(text, bytea, bigint, text[], text, text, boolean), core.mfa_passkey_list(),
  core.mfa_passkey_get(text), core.mfa_passkey_lookup(text, text),
  core.mfa_passkey_touch(uuid, bigint), core.mfa_passkey_remove(uuid),
  core.mfa_challenge_put(text, uuid, uuid, text, integer), core.mfa_challenge_take(uuid, text),
  core.mfa_login_state(uuid, uuid)
  to legallabs_app;
