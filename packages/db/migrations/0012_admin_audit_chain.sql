create schema admin;
revoke all on schema admin from public;
grant usage on schema admin to legallabs_app, legallabs_definer;
-- The definer role owns audit tables, so it creates each month's partition.
grant create on schema admin to legallabs_definer;
grant references on core.workspace to legallabs_definer;

alter default privileges in schema admin revoke execute on functions from public;

create table admin.audit_event (
  workspace_id uuid not null references core.workspace (id),
  seq bigint not null,
  at timestamptz not null,
  actor_type text not null check (actor_type in ('user', 'service', 'system', 'agent')),
  actor_id uuid,
  action text not null check (action ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),
  object_type text,
  object_id text,
  details jsonb not null default '{}',
  ip inet,
  ua_hash text,
  prev_hash bytea not null,
  hash bytea not null,
  -- The exact text that was hashed, so a verifier never has to rebuild it.
  canonical text not null,
  primary key (workspace_id, at, seq),
  constraint audit_event_actor_required check (actor_type = 'system' or actor_id is not null)
) partition by range (at);

-- The end of each chain; locking this row keeps concurrent writers in single file.
create table admin.audit_head (
  workspace_id uuid primary key references core.workspace (id),
  seq bigint not null default 0,
  hash bytea not null default '\x0000000000000000000000000000000000000000000000000000000000000000'
);

alter table admin.audit_event owner to legallabs_definer;
alter table admin.audit_head owner to legallabs_definer;

alter table admin.audit_event enable row level security;
alter table admin.audit_event force row level security;
alter table admin.audit_head enable row level security;
alter table admin.audit_head force row level security;

grant select on admin.audit_event, admin.audit_head to legallabs_app;

create policy audit_event_read on admin.audit_event for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.audit'));
create policy audit_event_append on admin.audit_event for insert to legallabs_definer
  with check (workspace_id = core.current_workspace_id());
create policy audit_head_read on admin.audit_head for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.audit'));
create policy audit_head_definer on admin.audit_head for all to legallabs_definer
  using (workspace_id = core.current_workspace_id())
  with check (workspace_id = core.current_workspace_id());

-- Partitions are reached only through the parent, whose policies apply.
create function admin.protect_audit_partition(partition_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  execute format('alter table admin.%I enable row level security', partition_name);
  execute format('alter table admin.%I force row level security', partition_name);
  execute format('create policy no_direct_access on admin.%I for select to legallabs_app using (false)',
                 partition_name);
end
$$;
alter function admin.protect_audit_partition(text) owner to legallabs_definer;

-- Catches any month without its own partition, so an audit write never fails for lack of one.
create table admin.audit_event_default partition of admin.audit_event default;
alter table admin.audit_event_default owner to legallabs_definer;
select admin.protect_audit_partition('audit_event_default');

create function admin.append_audit_event(
  p_action text,
  p_actor_type text,
  p_actor_id uuid,
  p_object_type text default null,
  p_object_id text default null,
  p_details jsonb default '{}',
  p_ip inet default null,
  p_ua_hash text default null
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  prev_seq bigint;
  prev_hash bytea;
  next_seq bigint;
  stamp timestamptz;
  body text;
  next_hash bytea;
begin
  if ws is null then
    raise exception 'audit event needs a workspace' using errcode = '42501';
  end if;
  -- Details hold ids and counts; anything this big is carrying content.
  if pg_column_size(p_details) > 8192 then
    raise exception 'audit details too large' using errcode = '22023';
  end if;

  insert into admin.audit_head (workspace_id) values (ws) on conflict do nothing;
  select h.seq, h.hash into prev_seq, prev_hash
    from admin.audit_head h where h.workspace_id = ws for update;

  next_seq := prev_seq + 1;
  stamp := clock_timestamp();
  body := jsonb_build_object(
    'workspace_id', ws,
    'seq', next_seq,
    'at', to_char(stamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor_type', p_actor_type,
    'actor_id', p_actor_id,
    'action', p_action,
    'object_type', p_object_type,
    'object_id', p_object_id,
    'details', p_details,
    'ip', p_ip,
    'ua_hash', p_ua_hash
  )::text;
  next_hash := sha256(prev_hash || convert_to(body, 'UTF8'));

  insert into admin.audit_event (workspace_id, seq, at, actor_type, actor_id, action, object_type,
                                 object_id, details, ip, ua_hash, prev_hash, hash, canonical)
  values (ws, next_seq, stamp, p_actor_type, p_actor_id, p_action, p_object_type,
          p_object_id, p_details, p_ip, p_ua_hash, prev_hash, next_hash, body);

  update admin.audit_head set seq = next_seq, hash = next_hash where workspace_id = ws;
  return next_seq;
end
$$;
alter function admin.append_audit_event(text, text, uuid, text, text, jsonb, inet, text)
  owner to legallabs_definer;
grant execute on function admin.append_audit_event(text, text, uuid, text, text, jsonb, inet, text)
  to legallabs_app;
