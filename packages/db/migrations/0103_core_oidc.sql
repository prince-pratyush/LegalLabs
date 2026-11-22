-- One OIDC provider per workspace. Holds no secret: that lives in its own table below.
create table core.oidc_provider (
  workspace_id uuid primary key references core.workspace (id) on delete cascade,
  issuer text not null check (issuer ~ '^https?://[^[:space:]?#]+$'),
  client_id text not null check (char_length(client_id) between 1 and 512),
  scopes text[] not null default array['openid', 'email', 'profile']
    check ('openid' = any (scopes)),
  enabled boolean not null default false,
  -- Where group names come from in the ID token, and the role each group maps to.
  groups_claim text check (char_length(groups_claim) between 1 and 100),
  role_mapping jsonb not null default '{}' check (jsonb_typeof(role_mapping) = 'object'),
  -- Refuses a sign-in the IdP did not strengthen with a second factor.
  require_mfa_claim boolean not null default false,
  mfa_acr_values text[] not null default '{}',
  -- Lets a first sign-in attach to a user an admin created with the same verified email.
  link_by_email boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Apart from the provider because every admin can read that table; here nobody can.
create table core.oidc_provider_secret (
  workspace_id uuid primary key references core.oidc_provider (workspace_id) on delete cascade,
  client_secret text not null check (char_length(client_secret) between 1 and 2048)
);

-- Identity is (issuer, subject). Email is only ever a one-time hint for the first link.
create table core.external_identity (
  workspace_id uuid not null,
  user_id uuid not null,
  issuer text not null,
  subject text not null check (char_length(subject) between 1 and 255),
  linked_at timestamptz not null default now(),
  linked_via text not null check (linked_via in ('email', 'scim')),
  last_login_at timestamptz,
  primary key (workspace_id, issuer, subject),
  -- One account per issuer, so a second subject can't ride on a linked user.
  unique (workspace_id, user_id, issuer),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);

-- Answers sent to the IdP: single use and short lived. Nothing here is readable by the app role.
create table core.oidc_auth_request (
  state_hash bytea primary key check (octet_length(state_hash) = 32),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  -- Ties the callback to the browser that started it, which stops login CSRF.
  binding_hash bytea not null check (octet_length(binding_hash) = 32),
  nonce text not null,
  code_verifier text not null,
  return_to text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

grant select, insert, update, delete on core.oidc_provider, core.oidc_provider_secret,
  core.external_identity, core.oidc_auth_request to legallabs_definer;
grant update (status) on core."user" to legallabs_definer;

alter table core.oidc_provider enable row level security;
alter table core.oidc_provider force row level security;
alter table core.oidc_provider_secret enable row level security;
alter table core.oidc_provider_secret force row level security;
alter table core.external_identity enable row level security;
alter table core.external_identity force row level security;
alter table core.oidc_auth_request enable row level security;
alter table core.oidc_auth_request force row level security;

create policy definer_all on core.oidc_provider for all to legallabs_definer
  using (true) with check (true);
create policy definer_all on core.oidc_provider_secret for all to legallabs_definer
  using (true) with check (true);
create policy definer_all on core.external_identity for all to legallabs_definer
  using (true) with check (true);
create policy definer_all on core.oidc_auth_request for all to legallabs_definer
  using (true) with check (true);
-- An invite is accepted by the first sign-in; nothing else about a user changes here.
create policy definer_activate on core."user" for update to legallabs_definer
  using (status = 'invited') with check (status = 'active');

grant select, insert, update, delete on core.oidc_provider to legallabs_app;
create policy oidc_provider_admin on core.oidc_provider for all to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.config'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));

grant select on core.external_identity to legallabs_app;
create policy external_identity_read on core.external_identity for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (user_id = core.current_user_id() or core.has_permission('admin.users')));

-- The only way to store a secret; the app role has no grant on the table.
create function core.set_oidc_client_secret(p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare ws uuid := core.current_workspace_id();
begin
  if ws is null or not core.in_tenant(ws) or not core.has_permission('admin.config') then
    raise exception 'not allowed to configure single sign-on' using errcode = '42501';
  end if;
  if p_secret is null then
    delete from core.oidc_provider_secret where workspace_id = ws;
  else
    insert into core.oidc_provider_secret (workspace_id, client_secret) values (ws, p_secret)
    on conflict (workspace_id) do update set client_secret = excluded.client_secret;
  end if;
end
$$;

-- Sign-in starts before anyone is known, so this stays narrow: no secret, enabled only.
create function core.oidc_login_config(workspace_slug text)
returns table (workspace_id uuid, issuer text, client_id text, scopes text[])
language sql stable security definer set search_path = '' as $$
  select w.id, p.issuer, p.client_id, p.scopes
    from core.workspace w join core.oidc_provider p on p.workspace_id = w.id
   where w.slug = oidc_login_config.workspace_slug and p.enabled
$$;

create function core.oidc_begin_request(
  p_workspace uuid, p_state_hash bytea, p_binding_hash bytea, p_nonce text,
  p_verifier text, p_return_to text, p_ttl_seconds int
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from core.oidc_provider p where p.workspace_id = p_workspace and p.enabled) then
    raise exception 'single sign-on is not enabled' using errcode = '42501';
  end if;
  -- Housekeeping here, so no separate job is needed.
  delete from core.oidc_auth_request where expires_at < now() - interval '1 day';
  insert into core.oidc_auth_request
    (state_hash, workspace_id, binding_hash, nonce, code_verifier, return_to, expires_at)
  values (p_state_hash, p_workspace, p_binding_hash, p_nonce, p_verifier, p_return_to,
          now() + make_interval(secs => p_ttl_seconds));
end
$$;

-- Marks the request used, whatever happens next, so a code or state can't be replayed.
-- The client secret leaves the database only here, for a request that is live and ours.
create function core.oidc_consume_request(p_state_hash bytea, p_binding_hash bytea)
returns table (
  status text, workspace_id uuid, nonce text, code_verifier text, return_to text,
  issuer text, client_id text, client_secret text, require_mfa_claim boolean,
  mfa_acr_values text[]
)
language plpgsql security definer set search_path = '' as $$
declare r core.oidc_auth_request;
begin
  select * into r from core.oidc_auth_request a
   where a.state_hash = p_state_hash and a.binding_hash = p_binding_hash for update;
  if not found then
    return;
  end if;
  if r.consumed_at is not null then
    return query select 'replayed', r.workspace_id, null::text, null::text, null::text,
      null::text, null::text, null::text, null::boolean, null::text[];
    return;
  end if;
  update core.oidc_auth_request a set consumed_at = now() where a.state_hash = p_state_hash;
  if r.expires_at <= now() then
    return query select 'expired', r.workspace_id, null::text, null::text, null::text,
      null::text, null::text, null::text, null::boolean, null::text[];
    return;
  end if;
  return query
    select 'ok', r.workspace_id, r.nonce, r.code_verifier, r.return_to,
           p.issuer, p.client_id, s.client_secret, p.require_mfa_claim, p.mfa_acr_values
      from core.oidc_provider p
      left join core.oidc_provider_secret s on s.workspace_id = p.workspace_id
     where p.workspace_id = r.workspace_id and p.enabled;
  if not found then
    return query select 'disabled', r.workspace_id, null::text, null::text, null::text,
      null::text, null::text, null::text, null::boolean, null::text[];
  end if;
end
$$;

-- Finds the person for a verified (issuer, subject), linking on first sight only when the
-- workspace allows it and an admin already created a matching user. Never creates a user.
create function core.oidc_resolve_user(
  p_workspace uuid, p_issuer text, p_subject text, p_email text, p_email_verified boolean
) returns table (outcome text, user_id uuid, scim_enabled boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_scim boolean;
  v_link boolean;
  v_user uuid;
  v_status text;
begin
  select coalesce((w.settings ->> 'scim_enabled') = 'true', false) into v_scim
    from core.workspace w where w.id = p_workspace;
  select p.link_by_email into v_link from core.oidc_provider p
   where p.workspace_id = p_workspace and p.enabled and p.issuer = p_issuer;
  if not found then
    return query select 'no_provider', null::uuid, v_scim;
    return;
  end if;

  select u.id, u.status into v_user, v_status
    from core.external_identity e
    join core."user" u on u.workspace_id = e.workspace_id and u.id = e.user_id
   where e.workspace_id = p_workspace and e.issuer = p_issuer and e.subject = p_subject;
  if found then
    if v_status <> 'active' then
      return query select 'not_active', v_user, v_scim;
      return;
    end if;
    update core.external_identity e set last_login_at = now()
     where e.workspace_id = p_workspace and e.issuer = p_issuer and e.subject = p_subject;
    return query select 'ok', v_user, v_scim;
    return;
  end if;

  if not v_link or p_email is null then
    return query select 'unprovisioned', null::uuid, v_scim;
    return;
  end if;
  if not coalesce(p_email_verified, false) then
    return query select 'email_unverified', null::uuid, v_scim;
    return;
  end if;
  select u.id, u.status into v_user, v_status from core."user" u
   where u.workspace_id = p_workspace and lower(u.email) = lower(p_email) and u.kind = 'member';
  if not found then
    return query select 'unprovisioned', null::uuid, v_scim;
    return;
  end if;
  if v_status not in ('invited', 'active') then
    return query select 'not_active', v_user, v_scim;
    return;
  end if;
  if exists (select 1 from core.external_identity e
              where e.workspace_id = p_workspace and e.user_id = v_user and e.issuer = p_issuer) then
    return query select 'identity_conflict', v_user, v_scim;
    return;
  end if;
  insert into core.external_identity (workspace_id, user_id, issuer, subject, linked_via, last_login_at)
  values (p_workspace, v_user, p_issuer, p_subject, 'email', now())
  on conflict do nothing;
  if not found then
    return query select 'identity_conflict', v_user, v_scim;
    return;
  end if;
  if v_status = 'invited' then
    update core."user" u set status = 'active' where u.workspace_id = p_workspace and u.id = v_user;
  end if;
  return query select 'first_link', v_user, v_scim;
end
$$;

alter function core.set_oidc_client_secret(text) owner to legallabs_definer;
alter function core.oidc_login_config(text) owner to legallabs_definer;
alter function core.oidc_begin_request(uuid, bytea, bytea, text, text, text, int) owner to legallabs_definer;
alter function core.oidc_consume_request(bytea, bytea) owner to legallabs_definer;
alter function core.oidc_resolve_user(uuid, text, text, text, boolean) owner to legallabs_definer;
grant execute on function core.set_oidc_client_secret(text), core.oidc_login_config(text),
  core.oidc_begin_request(uuid, bytea, bytea, text, text, text, int),
  core.oidc_consume_request(bytea, bytea),
  core.oidc_resolve_user(uuid, text, text, text, boolean) to legallabs_app;
