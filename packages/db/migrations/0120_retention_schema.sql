-- Retention: what the workspace keeps, for how long, and what is waiting in the recycle bin.
-- Admins read these tables through the app role; every write goes through a function in 0121.
create schema retention;
revoke all on schema retention from public;
grant usage on schema retention to legallabs_app, legallabs_definer, legallabs_worker;
alter default privileges in schema retention revoke execute on functions from public;

create table retention.policy (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  scope text not null check (scope in ('workspace', 'vault', 'matter')),
  -- The workspace's own id for the workspace scope.
  scope_id uuid not null,
  -- Null means kept for ever at this scope, which is a choice and not the same as no policy.
  hours integer check (hours is null or hours >= 3),
  basis text not null default 'upload' check (basis in ('upload', 'access')),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  unique (workspace_id, scope, scope_id),
  check (scope <> 'workspace' or scope_id = workspace_id)
);

create table retention.hold (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  object_type text not null
    check (object_type in ('thread', 'document', 'vault', 'review_table', 'matter')),
  object_id uuid not null,
  reason text not null check (char_length(reason) between 1 and 500),
  set_by uuid not null,
  set_at timestamptz not null default now(),
  unique (workspace_id, object_type, object_id)
);

create table retention.deletion_job (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  kind text not null check (kind in ('policy_change', 'sweep', 'purge')),
  policy_id uuid references retention.policy (id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  estimate jsonb,
  -- Counts and per-object failures; never names or content.
  report jsonb,
  scheduled_for timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  -- Null when the system started it.
  requested_by uuid,
  created_at timestamptz not null default now()
);
create index deletion_job_workspace_idx on retention.deletion_job (workspace_id, created_at desc);

create table retention.recycle_bin (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  object_type text not null check (object_type in ('thread', 'document', 'review_table')),
  -- No foreign key: the row outlives the object it names.
  object_id uuid not null,
  -- The name only, so an admin can tell items apart without reading any content.
  label text not null,
  policy_id uuid references retention.policy (id) on delete set null,
  job_id uuid references retention.deletion_job (id) on delete set null,
  deleted_at timestamptz not null default now(),
  restorable_until timestamptz not null,
  restored_at timestamptz,
  purged_at timestamptz
);
create unique index recycle_bin_open_idx on retention.recycle_bin
  (workspace_id, object_type, object_id) where restored_at is null and purged_at is null;
create index recycle_bin_due_idx on retention.recycle_bin (workspace_id, restorable_until)
  where restored_at is null and purged_at is null;

-- One row per vault, lead time and expiry day, so each warning goes out once.
create table retention.warning_sent (
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  vault_id uuid not null,
  lead_days integer not null check (lead_days in (1, 7, 30)),
  expires_on date not null,
  sent_at timestamptz not null default now(),
  primary key (vault_id, lead_days, expires_on)
);

alter table retention.policy enable row level security;
alter table retention.policy force row level security;
alter table retention.hold enable row level security;
alter table retention.hold force row level security;
alter table retention.deletion_job enable row level security;
alter table retention.deletion_job force row level security;
alter table retention.recycle_bin enable row level security;
alter table retention.recycle_bin force row level security;
alter table retention.warning_sent enable row level security;
alter table retention.warning_sent force row level security;

grant select on retention.policy, retention.hold, retention.deletion_job, retention.recycle_bin
  to legallabs_app;
grant select, insert, update, delete on retention.policy, retention.hold, retention.deletion_job,
  retention.recycle_bin, retention.warning_sent to legallabs_definer;

create policy policy_read on retention.policy for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.retention'));
create policy hold_read on retention.hold for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.retention'));
create policy job_read on retention.deletion_job for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.retention'));
create policy bin_read on retention.recycle_bin for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.retention'));

-- The definer works inside one workspace at a time, set by the caller or by the sweep.
create policy definer_all on retention.policy for all to legallabs_definer
  using (workspace_id = core.current_workspace_id())
  with check (workspace_id = core.current_workspace_id());
create policy definer_all on retention.hold for all to legallabs_definer
  using (workspace_id = core.current_workspace_id())
  with check (workspace_id = core.current_workspace_id());
create policy definer_all on retention.deletion_job for all to legallabs_definer
  using (workspace_id = core.current_workspace_id())
  with check (workspace_id = core.current_workspace_id());
create policy definer_all on retention.recycle_bin for all to legallabs_definer
  using (workspace_id = core.current_workspace_id())
  with check (workspace_id = core.current_workspace_id());
create policy definer_all on retention.warning_sent for all to legallabs_definer
  using (workspace_id = core.current_workspace_id())
  with check (workspace_id = core.current_workspace_id());

-- A thread in the bin is hidden from everyone who reads through its policy, and its
-- messages, drafts and runs follow because each of those looks the thread up.
alter table work.thread add column deleted_at timestamptz;
drop policy thread_read on work.thread;
create policy thread_read on work.thread for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and deleted_at is null
         and (owner_id = core.current_user_id() or core.has_access('thread', id, 'view'))
         and core.can_access_matter(matter_id));
drop policy thread_update on work.thread;
create policy thread_update on work.thread for update to legallabs_app
  using (core.in_tenant(workspace_id) and owner_id = core.current_user_id()
         and deleted_at is null and core.can_access_matter(matter_id))
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id());

-- Set when a file comes back from the bin, so retention counts from then.
alter table content.document add column restored_at timestamptz;
create function content.stamp_restored() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.deleted_at is not null and new.deleted_at is null then
    new.restored_at := now();
  end if;
  return new;
end
$$;
create trigger document_restored before update on content.document
  for each row execute function content.stamp_restored();

-- What the definer needs to bin, restore and purge.
grant update (deleted_at, last_activity_at), delete on work.thread to legallabs_definer;
create policy definer_write on work.thread for update to legallabs_definer
  using (workspace_id = core.current_workspace_id())
  with check (workspace_id = core.current_workspace_id());
create policy definer_delete on work.thread for delete to legallabs_definer
  using (workspace_id = core.current_workspace_id());

grant select, delete on work.review_table to legallabs_definer;
grant update (deleted_at, updated_at) on work.review_table to legallabs_definer;
create policy definer_all on work.review_table for all to legallabs_definer
  using (workspace_id = core.current_workspace_id())
  with check (workspace_id = core.current_workspace_id());

grant select on content.vault, core.matter, core.workspace to legallabs_definer;
grant update (retention_hours) on content.vault to legallabs_definer;
grant select on content.document_version to legallabs_definer;

-- The sweep first asks which workspaces have anything to do, before it enters any of them.
create policy definer_scan on retention.policy for select to legallabs_definer using (true);
create policy definer_scan on retention.recycle_bin for select to legallabs_definer using (true);
