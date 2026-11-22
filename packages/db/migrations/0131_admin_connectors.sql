-- Connectors admin (ADM-006, CON-001). A custom MCP server is registered by an admin, its
-- tool manifest is pinned by hash, and every tool carries a policy. New tools are blocked,
-- a changed manifest disables the connector until an admin approves again, and a person may
-- tighten a tool for themselves but never loosen it.
create table admin.connector (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  url text not null check (url ~ '^https://'),
  auth_kind text not null check (auth_kind in ('none', 'bearer', 'oauth_client')),
  secret_ref text,
  trust_tier text not null default 'custom'
    check (trust_tier in ('first_party', 'vendor', 'community', 'custom')),
  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'enabled', 'disabled')),
  manifest_hash text check (manifest_hash is null or manifest_hash ~ '^[0-9a-f]{64}$'),
  disabled_reason text check (disabled_reason in ('CONNECTOR_MANIFEST_CHANGED', 'ADMIN_DISABLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, name),
  foreign key (workspace_id, secret_ref) references admin.secret (workspace_id, id),
  -- Enabling needs a pinned manifest to hold the tools to.
  check (status <> 'enabled' or manifest_hash is not null)
);

create table admin.connector_tool (
  workspace_id uuid not null,
  connector_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  description text not null default '',
  input_schema jsonb not null default '{}',
  annotations jsonb not null default '{}',
  tool_hash text not null check (tool_hash ~ '^[0-9a-f]{64}$'),
  policy text not null default 'block' check (policy in ('allow', 'ask_user', 'block')),
  primary key (connector_id, name),
  foreign key (workspace_id, connector_id) references admin.connector (workspace_id, id)
    on delete cascade
);

create table admin.connector_user_policy (
  workspace_id uuid not null,
  connector_id uuid not null,
  user_id uuid not null,
  tool_name text not null,
  policy text not null check (policy in ('ask_user', 'block')),
  primary key (connector_id, user_id, tool_name),
  foreign key (workspace_id, connector_id) references admin.connector (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);

alter table admin.connector enable row level security;
alter table admin.connector force row level security;
alter table admin.connector_tool enable row level security;
alter table admin.connector_tool force row level security;
alter table admin.connector_user_policy enable row level security;
alter table admin.connector_user_policy force row level security;

grant select, insert, delete on admin.connector, admin.connector_tool to legallabs_app;
grant update (status, manifest_hash, disabled_reason, updated_at) on admin.connector
  to legallabs_app;
grant update (description, input_schema, annotations, tool_hash, policy)
  on admin.connector_tool to legallabs_app;
grant select, insert, update, delete on admin.connector_user_policy to legallabs_app;

-- People read connectors and tools to use them; only admins register, approve or set policy.
create policy connector_read on admin.connector for select to legallabs_app
  using (core.in_tenant(workspace_id));
create policy connector_write on admin.connector for all to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.config'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));
create policy tool_read on admin.connector_tool for select to legallabs_app
  using (core.in_tenant(workspace_id));
create policy tool_write on admin.connector_tool for all to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.config'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));
create policy user_policy_own on admin.connector_user_policy for all to legallabs_app
  using (core.in_tenant(workspace_id) and user_id = core.current_user_id())
  with check (core.in_tenant(workspace_id) and user_id = core.current_user_id());
