create table core.workspace (
  id uuid primary key default core.uuid7(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null check (char_length(name) between 1 and 200),
  region text not null check (region in ('us', 'eu', 'uk', 'au')),
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table core.role (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  builtin boolean not null default false,
  -- '*' grants every permission; only the Admin role should hold it.
  permissions text[] not null default '{}',
  unique (workspace_id, id),
  unique (workspace_id, name)
);

create table core."user" (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  email text not null check (email like '%_@_%'),
  name text not null default '',
  status text not null default 'invited'
    check (status in ('invited', 'active', 'suspended', 'deprovisioned')),
  kind text not null default 'member' check (kind in ('member', 'guest', 'service')),
  role_id uuid,
  extra_permissions text[] not null default '{}',
  profile jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  -- Including workspace_id stops a user pointing at another workspace's role.
  foreign key (workspace_id, role_id) references core.role (workspace_id, id)
);
create unique index user_email_key on core."user" (workspace_id, lower(email));
create index user_role_idx on core."user" (workspace_id, role_id);

-- Definer functions read through these policies; app rows stay behind their own.
grant select on core.workspace, core.role, core."user" to legallabs_definer;
create policy definer_read on core.workspace for select to legallabs_definer using (true);
create policy definer_read on core.role for select to legallabs_definer using (true);
create policy definer_read on core."user" for select to legallabs_definer using (true);

-- SECURITY DEFINER because the user table is itself behind RLS that calls this.
create function core.is_active_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core."user" u
     where u.id = core.current_user_id()
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active')
$$;

create function core.has_permission(permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select (permission = any (u.extra_permissions || r.permissions) or '*' = any (r.permissions))
           -- Guests and service accounts never hold admin permissions.
           and (u.kind = 'member' or permission not like 'admin.%')
      from core."user" u
      left join core.role r on r.workspace_id = u.workspace_id and r.id = u.role_id
     where u.id = core.current_user_id()
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active'), false)
$$;

-- The first clause of every policy: the row is in the caller's workspace and they are active.
create function core.in_tenant(row_workspace uuid) returns boolean
language sql stable as $$
  select row_workspace = core.current_workspace_id() and core.is_active_member()
$$;

alter function core.is_active_member() owner to legallabs_definer;
alter function core.has_permission(text) owner to legallabs_definer;
grant execute on function core.is_active_member(), core.has_permission(text), core.in_tenant(uuid)
  to legallabs_app, legallabs_definer;

alter table core.workspace enable row level security;
alter table core.workspace force row level security;
alter table core.role enable row level security;
alter table core.role force row level security;
alter table core."user" enable row level security;
alter table core."user" force row level security;

grant select, update on core.workspace to legallabs_app;
create policy workspace_read on core.workspace for select to legallabs_app
  using (core.in_tenant(id));
create policy workspace_update on core.workspace for update to legallabs_app
  using (core.in_tenant(id) and core.has_permission('admin.config'))
  with check (core.in_tenant(id));

grant select, insert, update, delete on core.role to legallabs_app;
create policy role_read on core.role for select to legallabs_app
  using (core.in_tenant(workspace_id));
create policy role_write on core.role for all to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.users'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.users'));

-- No delete: people are deprovisioned, so history keeps who did what.
grant select, insert, update on core."user" to legallabs_app;
create policy user_read on core."user" for select to legallabs_app
  using (core.in_tenant(workspace_id));
create policy user_insert on core."user" for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.users'));
create policy user_update on core."user" for update to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.users'))
  with check (core.in_tenant(workspace_id));
