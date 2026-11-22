-- Group to role mapping: people pushed into a mapped group get its role. A mapping to a role
-- that carries admin rights waits as 'pending' until a different admin confirms it, so one
-- compromised admin account cannot hand out admin access through the identity provider.
create table scim.group_role (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  group_id uuid not null,
  role_id uuid not null,
  -- Lower wins when a person sits in several mapped groups.
  priority integer not null default 100 check (priority between 0 and 10000),
  needs_confirmation boolean not null,
  state text not null check (state in ('pending', 'active')),
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  confirmed_by uuid,
  confirmed_at timestamptz,
  unique (workspace_id, group_id),
  unique (workspace_id, id),
  foreign key (workspace_id, group_id) references core."group" (workspace_id, id) on delete cascade,
  foreign key (workspace_id, role_id) references core.role (workspace_id, id) on delete cascade,
  constraint group_role_second_admin check (confirmed_by is null or confirmed_by <> requested_by),
  constraint group_role_confirmed check (
    state = 'pending' or not needs_confirmation or confirmed_by is not null)
);

alter table scim.group_role enable row level security;
alter table scim.group_role force row level security;
-- Reads only: every change goes through the functions below.
grant select on scim.group_role to legallabs_app, legallabs_definer;
grant insert, update, delete on scim.group_role to legallabs_definer;
create policy group_role_read on scim.group_role for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.users'));
create policy group_role_definer on scim.group_role for all to legallabs_definer
  using (true) with check (true);

grant update (role_id, role_from_group) on core."user" to legallabs_definer;
create policy definer_role_update on core."user" for update to legallabs_definer
  using (true) with check (true);

create function scim.holds_admin_rights(p_role uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select '*' = any (r.permissions)
                          or exists (select 1 from unnest(r.permissions) p where p like 'admin.%')
                     from core.role r
                    where r.id = p_role and r.workspace_id = core.current_workspace_id()), false)
$$;

-- Sets a person's role from the mapped groups they are in. A person who falls out of every
-- mapped group loses a role that only a mapping gave them.
create function scim.apply_group_roles(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  mapped uuid;
begin
  if not (scim.is_principal() or (core.in_tenant(ws) and core.has_permission('admin.users'))) then
    raise exception 'not allowed to apply group roles' using errcode = '42501';
  end if;
  select gr.role_id into mapped
    from scim.group_role gr
    join core.group_member m
      on m.workspace_id = gr.workspace_id and m.group_id = gr.group_id and m.user_id = p_user
   where gr.workspace_id = ws and gr.state = 'active'
   order by gr.priority, gr.requested_at
   limit 1;
  if mapped is not null then
    update core."user" set role_id = mapped, role_from_group = true
     where id = p_user and workspace_id = ws and kind = 'member'
       and (role_id is distinct from mapped or not role_from_group);
  else
    update core."user" set role_id = null, role_from_group = false
     where id = p_user and workspace_id = ws and kind = 'member' and role_from_group;
  end if;
end
$$;

create function scim.apply_group_roles_to_members(p_group uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  member uuid;
begin
  for member in select m.user_id from core.group_member m
                 where m.group_id = p_group and m.workspace_id = core.current_workspace_id()
  loop
    perform scim.apply_group_roles(member);
  end loop;
end
$$;

create function scim.request_group_role(p_group uuid, p_role uuid, p_priority integer default 100)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  needs boolean;
  new_id uuid;
begin
  if not (core.in_tenant(ws) and core.has_permission('admin.users')) then
    raise exception 'only an admin can map groups to roles' using errcode = '42501';
  end if;
  if not exists (select 1 from core."group" g where g.id = p_group and g.workspace_id = ws)
     or not exists (select 1 from core.role r where r.id = p_role and r.workspace_id = ws) then
    raise exception 'unknown group or role' using errcode = '22023';
  end if;
  -- Nobody can map a group to rights they do not hold themselves.
  if not core.holds_all(core.role_permissions(p_role)) then
    raise exception 'cannot grant permissions you do not hold' using errcode = '42501';
  end if;
  needs := scim.holds_admin_rights(p_role);
  insert into scim.group_role (workspace_id, group_id, role_id, priority, needs_confirmation, state,
                               requested_by)
  values (ws, p_group, p_role, p_priority, needs, case when needs then 'pending' else 'active' end,
          core.current_user_id())
  on conflict (workspace_id, group_id) do update
    set role_id = excluded.role_id, priority = excluded.priority,
        needs_confirmation = excluded.needs_confirmation, state = excluded.state,
        requested_by = excluded.requested_by, requested_at = now(),
        confirmed_by = null, confirmed_at = null
  returning id into new_id;
  perform scim.apply_group_roles_to_members(p_group);
  return new_id;
end
$$;

create function scim.confirm_group_role(p_mapping uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  m scim.group_role;
begin
  if not (core.in_tenant(ws) and core.has_permission('admin.users')) then
    raise exception 'only an admin can confirm a mapping' using errcode = '42501';
  end if;
  select * into m from scim.group_role where id = p_mapping and workspace_id = ws for update;
  if not found or m.state <> 'pending' then
    raise exception 'no pending mapping' using errcode = '22023';
  end if;
  if m.requested_by = core.current_user_id() then
    raise exception 'a different admin must confirm this mapping' using errcode = '42501';
  end if;
  if not core.holds_all(core.role_permissions(m.role_id)) then
    raise exception 'cannot grant permissions you do not hold' using errcode = '42501';
  end if;
  update scim.group_role set state = 'active', confirmed_by = core.current_user_id(),
         confirmed_at = now() where id = p_mapping;
  perform scim.apply_group_roles_to_members(m.group_id);
end
$$;

create function scim.remove_group_role(p_mapping uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  g uuid;
begin
  if not (core.in_tenant(ws) and core.has_permission('admin.users')) then
    raise exception 'only an admin can remove a mapping' using errcode = '42501';
  end if;
  delete from scim.group_role where id = p_mapping and workspace_id = ws returning group_id into g;
  if g is not null then
    perform scim.apply_group_roles_to_members(g);
  end if;
end
$$;

alter function scim.holds_admin_rights(uuid) owner to legallabs_definer;
alter function scim.apply_group_roles(uuid) owner to legallabs_definer;
alter function scim.apply_group_roles_to_members(uuid) owner to legallabs_definer;
alter function scim.request_group_role(uuid, uuid, integer) owner to legallabs_definer;
alter function scim.confirm_group_role(uuid) owner to legallabs_definer;
alter function scim.remove_group_role(uuid) owner to legallabs_definer;
grant execute on function scim.apply_group_roles(uuid), scim.request_group_role(uuid, uuid, integer),
  scim.confirm_group_role(uuid), scim.remove_group_role(uuid) to legallabs_app;
