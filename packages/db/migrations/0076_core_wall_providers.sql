-- Which provider is authoritative for synced wall rows; internal rows always sit alongside.
create table core.wall_provider (
  workspace_id uuid primary key references core.workspace (id) on delete cascade,
  kind text not null default 'internal'
    check (kind in ('internal', 'csv', 'intapp', 'imanage_spm')),
  config jsonb not null default '{}' check (jsonb_typeof(config) = 'object'),
  cadence_minutes integer check (cadence_minutes between 1 and 1440),
  -- A reference into the secret store, never the secret itself.
  secret_ref text check (char_length(secret_ref) <= 500),
  last_sync_at timestamptz,
  last_status text check (last_status in ('ok', 'failed', 'partial')),
  temporal_schedule_id text,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, updated_by) references core."user" (workspace_id, id)
);

create table core.wall_sync_report (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  provider text not null check (provider in ('internal', 'csv', 'intapp', 'imanage_spm')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running', 'ok', 'failed', 'partial')),
  stats jsonb not null default '{}',
  unresolved jsonb not null default '[]',
  created_by uuid,
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id)
);
create index wall_sync_report_recent_idx on core.wall_sync_report (workspace_id, started_at desc);

alter table core.wall_provider enable row level security;
alter table core.wall_provider force row level security;
alter table core.wall_sync_report enable row level security;
alter table core.wall_sync_report force row level security;

-- Matters admins see the provider; only config admins change it, as it holds a secret ref.
grant select, insert, update on core.wall_provider to legallabs_app;
create policy wall_provider_read on core.wall_provider for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (core.has_permission('admin.matters') or core.has_permission('admin.config')));
create policy wall_provider_insert on core.wall_provider for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));
create policy wall_provider_update on core.wall_provider for update to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.config'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));

grant select, insert, update on core.wall_sync_report to legallabs_app;
create policy wall_sync_report_admin on core.wall_sync_report for all to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.matters'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.matters'));

-- A parsed upload waits here between preview and apply; the token is the row id.
create table core.matter_import (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  kind text not null check (kind in ('matters', 'walls')),
  mode text not null check (mode in ('upsert', 'replace_missing_as_closed', 'replace')),
  rows jsonb not null check (jsonb_typeof(rows) = 'array'),
  preview jsonb not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '1 hour',
  applied_at timestamptz,
  report text,
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id)
);

alter table core.matter_import enable row level security;
alter table core.matter_import force row level security;
grant select, insert, update on core.matter_import to legallabs_app;
-- Only the admin who uploaded a file applies it.
create policy matter_import_own on core.matter_import for all to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.matters')
         and created_by = core.current_user_id())
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.matters')
              and created_by = core.current_user_id());

-- Walls are written by email and group name, and admins may not see every group.
create function core.find_wall_principal(p_type text, p_name text) returns uuid
language sql stable security definer set search_path = '' as $$
  select case
    when not core.has_permission('admin.matters') then null
    when p_type = 'user' then (
      select u.id from core."user" u
       where u.workspace_id = core.current_workspace_id()
         and lower(u.email) = lower(btrim(p_name)) and u.status <> 'deprovisioned')
    when p_type = 'group' then (
      select g.id from core."group" g
       where g.workspace_id = core.current_workspace_id()
         and (lower(g.name) = lower(btrim(p_name)) or g.scim_group_id = btrim(p_name))
       order by (lower(g.name) = lower(btrim(p_name))) desc limit 1)
  end
$$;
alter function core.find_wall_principal(text, text) owner to legallabs_definer;
grant execute on function core.find_wall_principal(text, text) to legallabs_app;

-- Names for wall rows and the principal picker, for matters admins only.
create function core.wall_principals(p_query text, p_ids uuid[])
returns table (principal_type text, principal_id uuid, label text)
language sql stable security definer set search_path = '' as $$
  select * from (
    select 'user'::text, u.id, u.email from core."user" u
     where u.workspace_id = core.current_workspace_id() and u.status <> 'deprovisioned'
       and (u.id = any (p_ids) or (p_query is not null
            and (u.email ilike '%' || p_query || '%' or u.name ilike '%' || p_query || '%')))
    union all
    select 'group', g.id, g.name from core."group" g
     where g.workspace_id = core.current_workspace_id()
       and (g.id = any (p_ids) or (p_query is not null and g.name ilike '%' || p_query || '%'))
  ) found
   where core.has_permission('admin.matters')
   order by 3 limit 200
$$;
alter function core.wall_principals(text, uuid[]) owner to legallabs_definer;
grant execute on function core.wall_principals(text, uuid[]) to legallabs_app;
