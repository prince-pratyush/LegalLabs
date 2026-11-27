-- Horizon scanning: a person's standing watch over public sources. A scan, what it was told to
-- look for and what it found are its owner's alone. The hourly refresh is a Postgres due-queue
-- that works each scan as its owner.

-- One row per workspace; without one, scanning is off.
create table apps.horizon_settings (
  workspace_id uuid primary key references core.workspace (id) on delete cascade,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table apps.horizon_scan (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  owner_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  purpose text not null check (char_length(purpose) between 1 and 2000),
  jurisdictions text[] not null default '{}' check (jurisdictions <@ array['US', 'UK']),
  industries text[] not null default '{}'
    check (cardinality(industries) <= 20 and pg_column_size(industries) <= 20000),
  topics text[] not null default '{}'
    check (cardinality(topics) <= 20 and pg_column_size(topics) <= 20000),
  sources text[] not null check (cardinality(sources) between 1 and 20
                                 and sources <@ array['fr', 'ecfr', 'uk_legislation']),
  from_date date not null,
  relevance_floor text not null default 'low' check (relevance_floor in ('high', 'medium', 'low')),
  -- Its owner could no longer run it; saving the scan again starts it.
  stopped boolean not null default false,
  next_refresh_at timestamptz not null default now(),
  last_refresh_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id),
  constraint horizon_scan_from_date
    check (from_date >= (created_at at time zone 'utc')::date - 28)
);
create index horizon_scan_owner_idx on apps.horizon_scan (owner_id, id desc);
create index horizon_scan_due_idx on apps.horizon_scan (next_refresh_at) where not stopped;

create table apps.horizon_cursor (
  scan_id uuid not null,
  source_id text not null check (source_id in ('fr', 'ecfr', 'uk_legislation')),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  cursor jsonb not null check (jsonb_typeof(cursor) = 'object' and pg_column_size(cursor) <= 2000),
  -- Refreshes in a row this source has failed.
  failures integer not null default 0 check (failures >= 0),
  last_ok_at timestamptz,
  last_error text check (char_length(last_error) <= 40),
  primary key (scan_id, source_id),
  foreign key (workspace_id, scan_id) references apps.horizon_scan (workspace_id, id)
    on delete cascade
);

-- What was found. Written once; the text is the source's, the explanation the model's.
create table apps.horizon_item (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  scan_id uuid not null,
  source_id text not null check (source_id in ('fr', 'ecfr', 'uk_legislation')),
  external_id text not null check (char_length(external_id) between 1 and 200),
  url text not null check (url like 'https://%' and char_length(url) <= 2000),
  title text not null check (char_length(title) between 1 and 1000),
  summary text not null check (char_length(summary) <= 4000),
  doc_type text not null check (char_length(doc_type) <= 40),
  jurisdiction text not null check (jurisdiction in ('US', 'UK')),
  published_on date not null,
  relevance text not null check (relevance in ('high', 'medium', 'low')),
  explanation text not null check (char_length(explanation) <= 2000),
  topics text[] not null default '{}' check (cardinality(topics) <= 20),
  industries text[] not null default '{}' check (cardinality(industries) <= 20),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (scan_id, url),
  foreign key (workspace_id, scan_id) references apps.horizon_scan (workspace_id, id)
    on delete cascade
);
create index horizon_item_scan_idx on apps.horizon_item (scan_id, published_on desc, id desc);

create table apps.horizon_item_state (
  user_id uuid not null,
  item_id uuid not null,
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  read_at timestamptz,
  starred boolean not null default false,
  -- Null until the person says; an old item then shows as archived by its age.
  archived boolean,
  primary key (user_id, item_id),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade,
  foreign key (workspace_id, item_id) references apps.horizon_item (workspace_id, id)
    on delete cascade
);
create index horizon_item_state_item_idx on apps.horizon_item_state (item_id);

-- What refreshing has cost. Only ever added to, and not tied to a scan, so deleting a scan
-- does not hand its allowance back.
create table apps.horizon_spend (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  owner_id uuid not null,
  usd numeric(12, 6) not null check (usd >= 0),
  at timestamptz not null default now(),
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id) on delete cascade
);
create index horizon_spend_idx on apps.horizon_spend (workspace_id, at);

alter table apps.horizon_settings enable row level security;
alter table apps.horizon_settings force row level security;
alter table apps.horizon_scan enable row level security;
alter table apps.horizon_scan force row level security;
alter table apps.horizon_cursor enable row level security;
alter table apps.horizon_cursor force row level security;
alter table apps.horizon_item enable row level security;
alter table apps.horizon_item force row level security;
alter table apps.horizon_item_state enable row level security;
alter table apps.horizon_item_state force row level security;
alter table apps.horizon_spend enable row level security;
alter table apps.horizon_spend force row level security;

grant select, insert on apps.horizon_settings to legallabs_app;
grant update (enabled, updated_at) on apps.horizon_settings to legallabs_app;
grant select, insert, delete on apps.horizon_scan to legallabs_app;
grant update (name, purpose, jurisdictions, industries, topics, sources, from_date,
              relevance_floor, stopped, next_refresh_at, last_refresh_at, updated_at)
  on apps.horizon_scan to legallabs_app;
grant select, insert, delete on apps.horizon_cursor to legallabs_app;
grant update (cursor, failures, last_ok_at, last_error) on apps.horizon_cursor to legallabs_app;
grant select, insert on apps.horizon_item, apps.horizon_spend to legallabs_app;
grant select, insert on apps.horizon_item_state to legallabs_app;
grant update (read_at, starred, archived) on apps.horizon_item_state to legallabs_app;

-- Scans are for members: no guest or service account has one.
create function apps.horizon_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core."user" u
                  where u.id = core.current_user_id()
                    and u.workspace_id = core.current_workspace_id()
                    and u.kind = 'member' and u.status = 'active')
$$;
alter function apps.horizon_member() owner to legallabs_definer;
revoke execute on function apps.horizon_member() from public;
grant execute on function apps.horizon_member() to legallabs_app;

create policy horizon_settings_read on apps.horizon_settings for select to legallabs_app
  using (core.in_tenant(workspace_id));
create policy horizon_settings_insert on apps.horizon_settings for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));
create policy horizon_settings_update on apps.horizon_settings for update to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.config'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));

-- The owner's and nobody else's, an admin's included.
create policy horizon_scan_read on apps.horizon_scan for select to legallabs_app
  using (core.in_tenant(workspace_id) and owner_id = core.current_user_id()
         and apps.horizon_member());
create policy horizon_scan_insert on apps.horizon_scan for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id()
              and apps.horizon_member() and core.has_permission('horizon.create')
              and not stopped and last_refresh_at is null);
create policy horizon_scan_update on apps.horizon_scan for update to legallabs_app
  using (core.in_tenant(workspace_id) and owner_id = core.current_user_id()
         and apps.horizon_member())
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id());
create policy horizon_scan_delete on apps.horizon_scan for delete to legallabs_app
  using (core.in_tenant(workspace_id) and owner_id = core.current_user_id()
         and apps.horizon_member());

-- Everything under a scan follows who can read the scan.
create policy horizon_cursor_all on apps.horizon_cursor for all to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from apps.horizon_scan s where s.id = scan_id))
  with check (core.in_tenant(workspace_id)
              and exists (select 1 from apps.horizon_scan s where s.id = scan_id));
create policy horizon_item_read on apps.horizon_item for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from apps.horizon_scan s where s.id = scan_id));
create policy horizon_item_insert on apps.horizon_item for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and core.has_permission('horizon.create')
              and exists (select 1 from apps.horizon_scan s where s.id = scan_id));
create policy horizon_item_state_own on apps.horizon_item_state for all to legallabs_app
  using (core.in_tenant(workspace_id) and user_id = core.current_user_id()
         and exists (select 1 from apps.horizon_item i where i.id = item_id))
  with check (core.in_tenant(workspace_id) and user_id = core.current_user_id()
              and exists (select 1 from apps.horizon_item i where i.id = item_id));
create policy horizon_spend_read on apps.horizon_spend for select to legallabs_app
  using (core.in_tenant(workspace_id) and owner_id = core.current_user_id());
create policy horizon_spend_insert on apps.horizon_spend for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id());

grant select on apps.horizon_settings, apps.horizon_spend to legallabs_definer;
grant select, update on apps.horizon_scan to legallabs_definer;
create policy definer_read on apps.horizon_settings for select to legallabs_definer using (true);
create policy definer_read on apps.horizon_spend for select to legallabs_definer using (true);
create policy definer_read on apps.horizon_scan for select to legallabs_definer using (true);
create policy definer_update on apps.horizon_scan for update to legallabs_definer
  using (true) with check (true);

-- The workspace's limit counts scans the caller cannot see; the lock makes the count hold.
create function apps.horizon_scan_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('horizon_scan:' || new.workspace_id::text, 0));
  if (select count(*) from apps.horizon_scan s where s.workspace_id = new.workspace_id) >= 100 then
    raise exception 'too many scans' using errcode = '54000';
  end if;
  return new;
end
$$;
alter function apps.horizon_scan_limit() owner to legallabs_definer;
revoke execute on function apps.horizon_scan_limit() from public;
grant execute on function apps.horizon_scan_limit() to legallabs_app, legallabs_definer;
create trigger horizon_scan_limit before insert on apps.horizon_scan
  for each row execute function apps.horizon_scan_limit();

-- What everyone in the caller's workspace has spent since then, for the shared daily cap.
create function apps.horizon_spent(p_since timestamptz) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(s.usd), 0) from apps.horizon_spend s
   where s.workspace_id = core.current_workspace_id() and core.is_active_member()
     and s.at > p_since
$$;
alter function apps.horizon_spent(timestamptz) owner to legallabs_definer;
revoke execute on function apps.horizon_spent(timestamptz) from public;
grant execute on function apps.horizon_spent(timestamptz) to legallabs_app;

-- The worker learns only which scan is due and whose it is.
create function apps.claim_horizon_scan(p_now timestamptz, p_lease_seconds integer,
                                        p_workspace uuid default null)
returns table (id uuid, workspace_id uuid, owner_id uuid)
language sql volatile security definer set search_path = '' as $$
  update apps.horizon_scan s
     set next_refresh_at = p_now + pg_catalog.make_interval(secs => p_lease_seconds)
   where s.id = (
     select x.id from apps.horizon_scan x
       join apps.horizon_settings g on g.workspace_id = x.workspace_id and g.enabled
      where not x.stopped and x.next_refresh_at <= p_now
        and (p_workspace is null or x.workspace_id = p_workspace)
      order by x.next_refresh_at, x.id
      limit 1
      for update of x skip locked)
  returning s.id, s.workspace_id, s.owner_id
$$;
alter function apps.claim_horizon_scan(timestamptz, integer, uuid) owner to legallabs_definer;
revoke execute on function apps.claim_horizon_scan(timestamptz, integer, uuid) from public;
grant execute on function apps.claim_horizon_scan(timestamptz, integer, uuid) to legallabs_worker;

-- For a scan its owner can no longer run. The audit event is the system's.
create function apps.stop_horizon_scan(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  was text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  ws uuid;
begin
  update apps.horizon_scan set stopped = true where id = p_id and not stopped
  returning workspace_id into ws;
  if ws is null then
    return;
  end if;
  perform pg_catalog.set_config('app.workspace_id', ws::text, true);
  perform admin.append_audit_event('horizon.scan.stopped', 'system', null, 'scan', p_id::text,
                                   '{"reason": "ACCESS_LOST"}'::jsonb);
  perform pg_catalog.set_config('app.workspace_id', was, true);
end
$$;
alter function apps.stop_horizon_scan(uuid) owner to legallabs_definer;
revoke execute on function apps.stop_horizon_scan(uuid) from public;
grant execute on function apps.stop_horizon_scan(uuid) to legallabs_worker;
