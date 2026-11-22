-- Mass-delete guard: an identity provider gone wrong (a bad sync, a stolen token) must not be
-- able to empty a workspace. Deprovisioning more than a tenth of the people within an hour
-- pauses it until an admin confirms. Settings: scim_mass_delete_percent (default 10) and
-- scim_mass_delete_min (default 2, so one departure in a tiny firm never trips it).
create table scim.guard (
  workspace_id uuid primary key references core.workspace (id) on delete cascade,
  paused_at timestamptz,
  paused_count integer,
  paused_population integer,
  resumed_at timestamptz,
  resumed_by uuid
);
create table scim.deprovision_event (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  user_id uuid not null,
  at timestamptz not null default now(),
  via text not null check (via in ('active', 'delete'))
);
create index deprovision_event_window_idx on scim.deprovision_event (workspace_id, at);

alter table scim.guard enable row level security;
alter table scim.guard force row level security;
alter table scim.deprovision_event enable row level security;
alter table scim.deprovision_event force row level security;

-- Written only by the functions below, so the provider cannot clear its own pause.
grant select on scim.guard, scim.deprovision_event to legallabs_app, legallabs_definer;
grant insert, update on scim.guard to legallabs_definer;
grant insert on scim.deprovision_event to legallabs_definer;
create policy guard_read on scim.guard for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (scim.is_principal() or core.has_permission('admin.users')));
create policy guard_definer on scim.guard for all to legallabs_definer using (true) with check (true);
create policy event_read on scim.deprovision_event for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.users'));
create policy event_definer on scim.deprovision_event for all to legallabs_definer
  using (true) with check (true);

-- Records one deprovisioning, or refuses it. 'tripped' means this one crossed the line: it was
-- not recorded and the caller must not apply it.
create function scim.record_deprovision(p_user uuid, p_via text)
returns table (outcome text, events integer, population integer)
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  g scim.guard;
  pct integer;
  floor_n integer;
  since timestamptz;
  n integer;
  pop integer;
begin
  if not scim.is_principal() then
    raise exception 'not the SCIM principal' using errcode = '42501';
  end if;
  insert into scim.guard (workspace_id) values (ws) on conflict do nothing;
  select * into g from scim.guard where workspace_id = ws for update;
  if g.paused_at is not null then
    return query select 'paused', g.paused_count, g.paused_population;
    return;
  end if;
  select coalesce((w.settings ->> 'scim_mass_delete_percent')::integer, 10),
         coalesce((w.settings ->> 'scim_mass_delete_min')::integer, 2)
    into pct, floor_n from core.workspace w where w.id = ws;
  since := greatest(now() - interval '1 hour', coalesce(g.resumed_at, '-infinity'));
  n := (select count(*) from scim.deprovision_event e where e.workspace_id = ws and e.at >= since) + 1;
  -- People already removed in the window were part of the population when it began.
  pop := (select count(*) from core."user" u
           where u.workspace_id = ws and u.kind = 'member' and u.status <> 'deprovisioned')
         + (n - 1);
  if n >= floor_n and n * 100 > pct * pop then
    update scim.guard set paused_at = now(), paused_count = n, paused_population = pop
     where workspace_id = ws;
    return query select 'tripped', n, pop;
    return;
  end if;
  insert into scim.deprovision_event (workspace_id, user_id, via) values (ws, p_user, p_via);
  return query select 'ok', n, pop;
end
$$;

-- An admin lets provisioning carry on; the hour's count starts again from now.
create function scim.resume_provisioning() returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
begin
  if not (core.in_tenant(ws) and core.has_permission('admin.users')) then
    raise exception 'only an admin can resume provisioning' using errcode = '42501';
  end if;
  update scim.guard set paused_at = null, paused_count = null, paused_population = null,
         resumed_at = now(), resumed_by = core.current_user_id()
   where workspace_id = ws and paused_at is not null;
  return found;
end
$$;
alter function scim.record_deprovision(uuid, text) owner to legallabs_definer;
alter function scim.resume_provisioning() owner to legallabs_definer;
grant execute on function scim.record_deprovision(uuid, text), scim.resume_provisioning()
  to legallabs_app;
