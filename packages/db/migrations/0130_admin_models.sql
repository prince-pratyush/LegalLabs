-- Models configuration (ADM-005). Admins set which models exist for the workspace, who may use
-- them, and the workspace-wide rules (ZDR only, one region). A bring-your-own key is stored
-- sealed in admin.secret; model_config keeps only its reference.

-- Sealed values. The app role can add and remove them but never read the sealed bytes back:
-- the column grant leaves ciphertext out, and the one read path is a function for the worker.
create table admin.secret (
  id text primary key check (id ~ '^sec_[0-9a-f]{32}$'),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  ciphertext bytea not null check (octet_length(ciphertext) between 29 and 8192),
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table admin.model_config (
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 60),
  model text not null check (char_length(model) between 1 and 120),
  enabled boolean not null default false,
  enabled_for_roles uuid[] not null default '{}' check (cardinality(enabled_for_roles) <= 200),
  enabled_for_users uuid[] not null default '{}' check (cardinality(enabled_for_users) <= 1000),
  byok_secret_ref text,
  endpoint_url text check (endpoint_url is null or endpoint_url ~ '^https?://'),
  region text not null default 'unspecified' check (char_length(region) between 1 and 40),
  zdr boolean not null default false,
  capabilities text[] not null default '{chat}'
    check (capabilities <@ array['chat', 'embed', 'rerank']),
  context_window integer check (context_window is null or context_window > 0),
  task_class_default text[] not null default '{}'
    check (task_class_default <@ array['synthesize', 'plan', 'read_extract', 'draft_edit']),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, provider, model),
  foreign key (workspace_id, byok_secret_ref) references admin.secret (workspace_id, id),
  -- A local endpoint is in the deployment's own network: no region to pick, and ZDR by definition.
  check (region <> 'local' or zdr)
);

create table admin.model_policy (
  workspace_id uuid primary key references core.workspace (id) on delete cascade,
  zdr_only boolean not null default false,
  region_only text check (region_only is null or char_length(region_only) between 1 and 40),
  selector_disabled_roles uuid[] not null default '{}'
    check (cardinality(selector_disabled_roles) <= 200),
  updated_at timestamptz not null default now()
);

alter table admin.secret enable row level security;
alter table admin.secret force row level security;
alter table admin.model_config enable row level security;
alter table admin.model_config force row level security;
alter table admin.model_policy enable row level security;
alter table admin.model_policy force row level security;

grant select (id, workspace_id, created_at), insert, delete on admin.secret to legallabs_app;
grant select, insert, delete on admin.model_config to legallabs_app;
grant update (enabled, enabled_for_roles, enabled_for_users, byok_secret_ref, endpoint_url, region,
              zdr, capabilities, context_window, task_class_default, updated_at)
  on admin.model_config to legallabs_app;
grant select, insert on admin.model_policy to legallabs_app;
grant update (zdr_only, region_only, selector_disabled_roles, updated_at)
  on admin.model_policy to legallabs_app;

create policy secret_admin on admin.secret for all to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.config'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));

-- Everyone in the workspace reads the registry (to build the selector); only admins change it.
create policy model_read on admin.model_config for select to legallabs_app
  using (core.in_tenant(workspace_id));
create policy model_write on admin.model_config for all to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.config'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));
create policy model_policy_read on admin.model_policy for select to legallabs_app
  using (core.in_tenant(workspace_id));
create policy model_policy_write on admin.model_policy for all to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.config'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));

-- The model gateway's one way to get a key at call time: the sealed bytes for one reference in
-- one workspace, for the worker role only.
grant select on admin.secret to legallabs_definer;
create policy secret_definer on admin.secret for select to legallabs_definer using (true);
create function admin.read_secret(p_workspace uuid, p_ref text) returns bytea
language sql stable security definer set search_path = '' as $$
  select s.ciphertext from admin.secret s where s.workspace_id = p_workspace and s.id = p_ref
$$;
alter function admin.read_secret(uuid, text) owner to legallabs_definer;
revoke execute on function admin.read_secret(uuid, text) from public;
grant execute on function admin.read_secret(uuid, text) to legallabs_worker;
-- The worker reaches nothing else in this schema: usage lets it call the one function above.
grant usage on schema admin to legallabs_worker;
