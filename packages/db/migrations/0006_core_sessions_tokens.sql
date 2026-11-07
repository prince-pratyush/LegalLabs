-- Secrets are never stored: the app sends a SHA-256 hash and looks it up.
create table core.session (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  user_id uuid not null,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip inet,
  ua_hash text,
  mfa_at timestamptz,
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);
create index session_user_idx on core.session (workspace_id, user_id);

create table core.api_token (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  principal_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  scopes text[] not null check (
    cardinality(scopes) > 0
    and scopes <@ array['audit:read', 'history:read', 'vaults:read', 'vaults:write',
                        'tables:read', 'agents:run', 'scim', 'whoami']),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null check (expires_at <= created_at + interval '365 days'),
  last_used_at timestamptz,
  revoked_at timestamptz,
  foreign key (workspace_id, principal_id) references core."user" (workspace_id, id) on delete cascade
);
create index api_token_principal_idx on core.api_token (workspace_id, principal_id);

grant select on core.session, core.api_token to legallabs_definer;
create policy definer_read on core.session for select to legallabs_definer using (true);
create policy definer_read on core.api_token for select to legallabs_definer using (true);

-- Login runs before app.user_id exists, so these narrow lookups are the only way in.
-- Each returns at most one row and only what the next step needs.
create function core.find_login_user(workspace_slug text, email text)
returns table (user_id uuid, workspace_id uuid, status text)
language sql stable security definer set search_path = '' as $$
  select u.id, u.workspace_id, u.status
    from core."user" u join core.workspace w on w.id = u.workspace_id
   where w.slug = find_login_user.workspace_slug
     and lower(u.email) = lower(find_login_user.email)
     and u.kind <> 'service'
$$;

create function core.resolve_session(token_hash bytea)
returns table (session_id uuid, user_id uuid, workspace_id uuid, mfa_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.id, s.user_id, s.workspace_id, s.mfa_at
    from core.session s join core."user" u on u.workspace_id = s.workspace_id and u.id = s.user_id
   where s.token_hash = resolve_session.token_hash
     and s.revoked_at is null
     and s.expires_at > now()
     and u.status = 'active'
$$;

create function core.resolve_api_token(token_hash bytea)
returns table (token_id uuid, principal_id uuid, workspace_id uuid, scopes text[])
language sql stable security definer set search_path = '' as $$
  select t.id, t.principal_id, t.workspace_id, t.scopes
    from core.api_token t join core."user" u on u.workspace_id = t.workspace_id and u.id = t.principal_id
   where t.token_hash = resolve_api_token.token_hash
     and t.revoked_at is null
     and t.expires_at > now()
     and u.status = 'active'
$$;

alter function core.find_login_user(text, text) owner to legallabs_definer;
alter function core.resolve_session(bytea) owner to legallabs_definer;
alter function core.resolve_api_token(bytea) owner to legallabs_definer;
grant execute on function core.find_login_user(text, text), core.resolve_session(bytea),
  core.resolve_api_token(bytea) to legallabs_app;

alter table core.session enable row level security;
alter table core.session force row level security;
alter table core.api_token enable row level security;
alter table core.api_token force row level security;

grant select, insert on core.session to legallabs_app;
grant update (revoked_at, mfa_at) on core.session to legallabs_app;
create policy session_read on core.session for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (user_id = core.current_user_id() or core.has_permission('admin.users')));
create policy session_insert on core.session for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and user_id = core.current_user_id());
create policy session_update on core.session for update to legallabs_app
  using (core.in_tenant(workspace_id)
         and (user_id = core.current_user_id() or core.has_permission('admin.users')))
  with check (core.in_tenant(workspace_id));

grant select, insert on core.api_token to legallabs_app;
grant update (last_used_at, revoked_at) on core.api_token to legallabs_app;
create policy api_token_read on core.api_token for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (principal_id = core.current_user_id() or core.has_permission('admin.users')));
create policy api_token_insert on core.api_token for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.users'));
create policy api_token_update on core.api_token for update to legallabs_app
  using (core.in_tenant(workspace_id)
         and (principal_id = core.current_user_id() or core.has_permission('admin.users')))
  with check (core.in_tenant(workspace_id));
