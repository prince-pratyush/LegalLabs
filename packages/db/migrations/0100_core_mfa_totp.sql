-- Second factors live apart from core."user", which every member can read. The app role gets no
-- grant on any of these tables: the functions below are its only way in, and each one acts on the
-- current person only.

-- Existing settings may hold other keys, so only the mfa key is checked. A missing key means the
-- default, 'admins'.
alter table core.workspace add constraint workspace_mfa_policy
  check (settings ->> 'mfa' is null or settings ->> 'mfa' in ('off', 'admins', 'all', 'all_incl_guests'));

create table core.mfa_totp (
  workspace_id uuid not null,
  user_id uuid not null,
  -- Sealed by the app, so a database dump alone cannot produce codes.
  secret_enc bytea not null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  -- Highest time step already accepted: a code can be used once.
  last_counter bigint not null default 0,
  primary key (workspace_id, user_id),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);

create table core.mfa_recovery_code (
  workspace_id uuid not null,
  user_id uuid not null,
  code_hash bytea not null check (octet_length(code_hash) = 32),
  created_at timestamptz not null default now(),
  used_at timestamptz,
  primary key (workspace_id, user_id, code_hash),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);

-- Proof that the password step passed, held until a second factor completes the sign-in.
-- 'enrol' is for people the policy covers who have no factor yet: it opens enrolment only.
create table core.mfa_pending (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  user_id uuid not null,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  purpose text not null check (purpose in ('verify', 'enrol')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);
create index mfa_pending_user_idx on core.mfa_pending (workspace_id, user_id);

grant select, insert, update, delete on core.mfa_totp, core.mfa_recovery_code, core.mfa_pending
  to legallabs_definer;
alter table core.mfa_totp enable row level security;
alter table core.mfa_totp force row level security;
alter table core.mfa_recovery_code enable row level security;
alter table core.mfa_recovery_code force row level security;
alter table core.mfa_pending enable row level security;
alter table core.mfa_pending force row level security;
create policy definer_all on core.mfa_totp for all to legallabs_definer using (true) with check (true);
create policy definer_all on core.mfa_recovery_code for all to legallabs_definer using (true) with check (true);
create policy definer_all on core.mfa_pending for all to legallabs_definer using (true) with check (true);

create function core.mfa_totp_begin(p_secret bytea) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not core.is_active_member() then
    raise exception 'not an active member' using errcode = '42501';
  end if;
  -- A confirmed secret is never replaced: remove it first, which needs a fresh factor.
  insert into core.mfa_totp (workspace_id, user_id, secret_enc)
  values (core.current_workspace_id(), core.current_user_id(), p_secret)
  on conflict (workspace_id, user_id)
    do update set secret_enc = excluded.secret_enc, created_at = now()
    where core.mfa_totp.confirmed_at is null;
  if not found then
    raise exception 'authenticator already enrolled' using errcode = '23505';
  end if;
end
$$;

create function core.mfa_totp_get()
returns table (secret_enc bytea, confirmed boolean, last_counter bigint)
language sql stable security definer set search_path = '' as $$
  select t.secret_enc, t.confirmed_at is not null, t.last_counter
    from core.mfa_totp t
   where t.workspace_id = core.current_workspace_id()
     and t.user_id = core.current_user_id()
     and core.is_active_member()
$$;

-- The compare-and-set is the replay guard: two requests with one code cannot both win.
create function core.mfa_totp_accept(p_counter bigint, p_confirm boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not core.is_active_member() then
    return false;
  end if;
  update core.mfa_totp t
     set last_counter = p_counter,
         confirmed_at = case when p_confirm then now() else t.confirmed_at end
   where t.workspace_id = core.current_workspace_id()
     and t.user_id = core.current_user_id()
     and t.last_counter < p_counter
     and (t.confirmed_at is not null) <> p_confirm;
  return found;
end
$$;

create function core.mfa_totp_delete() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not core.is_active_member() then
    return false;
  end if;
  delete from core.mfa_totp
   where workspace_id = core.current_workspace_id() and user_id = core.current_user_id();
  return found;
end
$$;

create function core.mfa_recovery_replace(p_hashes bytea[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not core.is_active_member() then
    raise exception 'not an active member' using errcode = '42501';
  end if;
  delete from core.mfa_recovery_code
   where workspace_id = core.current_workspace_id() and user_id = core.current_user_id();
  insert into core.mfa_recovery_code (workspace_id, user_id, code_hash)
  select core.current_workspace_id(), core.current_user_id(), h from unnest(p_hashes) as h;
end
$$;

create function core.mfa_recovery_consume(p_hash bytea) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not core.is_active_member() then
    return false;
  end if;
  update core.mfa_recovery_code
     set used_at = now()
   where workspace_id = core.current_workspace_id()
     and user_id = core.current_user_id()
     and code_hash = p_hash
     and used_at is null;
  return found;
end
$$;

create function core.mfa_recovery_clear() returns void
language sql security definer set search_path = '' as $$
  delete from core.mfa_recovery_code
   where workspace_id = core.current_workspace_id()
     and user_id = core.current_user_id()
     and core.is_active_member()
$$;

-- Called with the identity of the person who just passed the password step.
create function core.mfa_pending_create(p_purpose text, p_token_hash bytea, p_secs integer)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
begin
  if not core.is_active_member() then
    raise exception 'not an active member' using errcode = '42501';
  end if;
  if p_secs not between 1 and 900 then
    raise exception 'pending sign-in lifetime out of range' using errcode = '22023';
  end if;
  delete from core.mfa_pending where expires_at < now() - interval '1 day';
  insert into core.mfa_pending (workspace_id, user_id, token_hash, purpose, expires_at)
  values (core.current_workspace_id(), core.current_user_id(), p_token_hash, p_purpose,
          now() + make_interval(secs => p_secs))
  returning id into new_id;
  return new_id;
end
$$;

-- Runs before any identity exists. Five wrong guesses retire the pending sign-in.
create function core.mfa_pending_resolve(p_token_hash bytea)
returns table (id uuid, workspace_id uuid, user_id uuid, purpose text, attempts integer)
language sql stable security definer set search_path = '' as $$
  select p.id, p.workspace_id, p.user_id, p.purpose, p.attempts
    from core.mfa_pending p
    join core."user" u on u.workspace_id = p.workspace_id and u.id = p.user_id
   where p.token_hash = p_token_hash
     and p.consumed_at is null
     and p.expires_at > now()
     and p.attempts < 5
     and u.status = 'active'
$$;

create function core.mfa_pending_strike(p_id uuid) returns integer
language sql security definer set search_path = '' as $$
  update core.mfa_pending set attempts = attempts + 1
   where id = p_id and consumed_at is null
  returning attempts
$$;

create function core.mfa_pending_consume(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update core.mfa_pending
     set consumed_at = now()
   where id = p_id and consumed_at is null and expires_at > now() and attempts < 5;
  return found;
end
$$;

alter function core.mfa_totp_begin(bytea) owner to legallabs_definer;
alter function core.mfa_totp_get() owner to legallabs_definer;
alter function core.mfa_totp_accept(bigint, boolean) owner to legallabs_definer;
alter function core.mfa_totp_delete() owner to legallabs_definer;
alter function core.mfa_recovery_replace(bytea[]) owner to legallabs_definer;
alter function core.mfa_recovery_consume(bytea) owner to legallabs_definer;
alter function core.mfa_recovery_clear() owner to legallabs_definer;
alter function core.mfa_pending_create(text, bytea, integer) owner to legallabs_definer;
alter function core.mfa_pending_resolve(bytea) owner to legallabs_definer;
alter function core.mfa_pending_strike(uuid) owner to legallabs_definer;
alter function core.mfa_pending_consume(uuid) owner to legallabs_definer;
grant execute on function core.mfa_totp_begin(bytea), core.mfa_totp_get(),
  core.mfa_totp_accept(bigint, boolean), core.mfa_totp_delete(), core.mfa_recovery_replace(bytea[]),
  core.mfa_recovery_consume(bytea), core.mfa_recovery_clear(),
  core.mfa_pending_create(text, bytea, integer), core.mfa_pending_resolve(bytea),
  core.mfa_pending_strike(uuid), core.mfa_pending_consume(uuid)
  to legallabs_app;
