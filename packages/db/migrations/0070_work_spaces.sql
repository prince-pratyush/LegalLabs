-- A Space is a shared room around one matter's work: people, shared resources, phases and tasks.
create table work.space (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  kind text not null default 'internal' check (kind in ('internal', 'external')),
  matter_id uuid,
  -- {version, summary?, parties[], key_dates[], standing_instructions?}; the API validates the shape.
  context jsonb not null default '{"version": 1, "parties": [], "key_dates": []}'
    check (jsonb_typeof(context) = 'object' and pg_column_size(context) <= 60000),
  customization jsonb not null default '{}' check (jsonb_typeof(customization) = 'object'),
  template_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id),
  foreign key (workspace_id, matter_id) references core.matter (workspace_id, id)
);
-- Names are unique ignoring case; a matter has at most one live Space (the 1:1 rule).
create unique index space_name_idx on work.space (workspace_id, lower(name)) where deleted_at is null;
create unique index space_matter_idx on work.space (workspace_id, matter_id)
  where matter_id is not null and deleted_at is null;

create table work.space_member (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  space_id uuid not null,
  principal_type text not null check (principal_type in ('user', 'group')),
  principal_id uuid not null,
  role text not null check (role in ('admin', 'collaborator')),
  invited_by uuid,
  joined_at timestamptz not null default now(),
  unique (space_id, principal_type, principal_id),
  foreign key (workspace_id, space_id) references work.space (workspace_id, id) on delete cascade
);
create index space_member_principal_idx on work.space_member (principal_type, principal_id);

create trigger space_member_principal
  before insert or update of workspace_id, principal_type, principal_id
  on work.space_member for each row execute function core.check_principal();

-- A resource shared into a Space at a level. `per_party` is reserved for external Spaces.
create table work.space_resource (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  space_id uuid not null,
  resource_type text not null check (resource_type in (
    'vault', 'playbook', 'review_table', 'thread', 'agent', 'workflow', 'scan')),
  resource_id uuid not null,
  access text not null check (access in ('view', 'run', 'edit', 'full')),
  per_party jsonb not null default '{}' check (jsonb_typeof(per_party) = 'object'),
  granted_by uuid not null,
  created_at timestamptz not null default now(),
  suspended_reason text,
  unique (space_id, resource_type, resource_id),
  foreign key (workspace_id, space_id) references work.space (workspace_id, id) on delete cascade,
  foreign key (workspace_id, granted_by) references core."user" (workspace_id, id)
);
create index space_resource_resource_idx on work.space_resource (resource_type, resource_id);

-- Who did what in a Space. Details never carry content, only ids and short labels.
create table work.space_activity (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  space_id uuid not null,
  actor_id uuid,
  actor_type text not null default 'user' check (actor_type in ('user', 'assistant', 'agent', 'system')),
  type text not null check (char_length(type) between 1 and 64),
  object_type text check (char_length(object_type) <= 32),
  object_id uuid,
  details jsonb not null default '{}' check (jsonb_typeof(details) = 'object'),
  at timestamptz not null default now(),
  foreign key (workspace_id, space_id) references work.space (workspace_id, id) on delete cascade
);
create index space_activity_idx on work.space_activity (space_id, at desc, id desc);

-- The definer functions below read these tables as the caller could not.
grant select on work.space, work.space_member, work.space_resource to legallabs_definer;
grant usage on schema work to legallabs_definer;
create policy definer_read on work.space for select to legallabs_definer using (true);
create policy definer_read on work.space_member for select to legallabs_definer using (true);
create policy definer_read on work.space_resource for select to legallabs_definer using (true);

-- The caller's own role in a live Space they can reach: direct or through a group. A Space is live
-- when it isn't deleted and its matter isn't walled off from the caller.
create function work.space_membership(p_space uuid) returns text
language sql stable security definer set search_path = '' as $$
  with me as (
    select u.id, u.workspace_id from core."user" u
     where u.id = core.current_user_id()
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active' and u.kind = 'member'
  )
  select (select m.role
            from work.space_member m
            join me on m.workspace_id = me.workspace_id
            join work.space s on s.id = m.space_id and s.workspace_id = m.workspace_id
           where m.space_id = p_space
             and s.deleted_at is null
             and core.can_access_matter(s.matter_id)
             and ((m.principal_type = 'user' and m.principal_id = me.id)
               or (m.principal_type = 'group' and exists (
                     select 1 from core.group_member g
                      where g.group_id = m.principal_id and g.user_id = me.id
                        and g.workspace_id = me.workspace_id)))
           order by (m.role = 'admin') desc
           limit 1)
$$;

-- Members and `spaces.manage` holders may act in a Space; the latter as its admin.
create function work.space_role(p_space uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    work.space_membership(p_space),
    (select 'admin' from work.space s
      where s.id = p_space and s.deleted_at is null
        and s.workspace_id = core.current_workspace_id()
        and core.has_permission('spaces.manage')
        and core.can_access_matter(s.matter_id)))
$$;

alter function work.space_membership(uuid) owner to legallabs_definer;
alter function work.space_role(uuid) owner to legallabs_definer;
grant execute on function work.space_membership(uuid), work.space_role(uuid)
  to legallabs_app, legallabs_definer;

-- Whether a user is in a Space, directly or through a group. Callers may not read groups they are
-- not in, so assigning a task or mentioning someone asks here instead.
create function work.user_in_space(p_space uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select work.space_role(p_space) is not null and exists (
    select 1 from work.space_member m
     where m.space_id = p_space
       and m.workspace_id = core.current_workspace_id()
       and ((m.principal_type = 'user' and m.principal_id = p_user)
         or (m.principal_type = 'group' and exists (
               select 1 from core.group_member g
                where g.group_id = m.principal_id and g.user_id = p_user
                  and g.workspace_id = m.workspace_id)))
       and exists (select 1 from core."user" u
                    where u.id = p_user and u.workspace_id = m.workspace_id
                      and u.status = 'active' and u.kind = 'member'))
$$;
alter function work.user_in_space(uuid, uuid) owner to legallabs_definer;
grant execute on function work.user_in_space(uuid, uuid) to legallabs_app;

-- A creator is always its first admin, however the row was made.
create function work.space_first_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into work.space_member (workspace_id, space_id, principal_type, principal_id, role, invited_by)
  values (new.workspace_id, new.id, 'user', new.created_by, 'admin', new.created_by);
  return new;
end
$$;
alter function work.space_first_admin() owner to legallabs_definer;
grant insert on work.space_member to legallabs_definer;
create policy definer_insert on work.space_member for insert to legallabs_definer with check (true);
create trigger space_first_admin after insert on work.space
  for each row execute function work.space_first_admin();

-- Soft delete runs as definer: the deleted row no longer passes the read policy, so a plain update
-- by the caller is refused when the database re-checks the new row.
grant update (deleted_at) on work.space to legallabs_definer;
create policy definer_delete on work.space for update to legallabs_definer using (true) with check (true);
create function work.delete_space(p_space uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- Its creator, or someone who manages every Space; either way an admin of this one.
  if work.space_role(p_space) is distinct from 'admin' then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  update work.space set deleted_at = now()
   where id = p_space and workspace_id = core.current_workspace_id() and deleted_at is null
     and (created_by = core.current_user_id() or core.has_permission('spaces.manage'));
  if not found then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
end
$$;
alter function work.delete_space(uuid) owner to legallabs_definer;
grant execute on function work.delete_space(uuid) to legallabs_app;

-- The kind never changes, and a matter, once attached, is only removed by `spaces.manage`.
create function work.guard_space() returns trigger
language plpgsql as $$
begin
  if new.kind is distinct from old.kind then
    raise exception 'KIND_IMMUTABLE' using errcode = 'check_violation';
  end if;
  if current_user = 'legallabs_app'
     and old.matter_id is not null and new.matter_id is distinct from old.matter_id
     and not core.has_permission('spaces.manage') then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger space_guard before update on work.space
  for each row execute function work.guard_space();

alter table work.space enable row level security;
alter table work.space force row level security;
alter table work.space_member enable row level security;
alter table work.space_member force row level security;
alter table work.space_resource enable row level security;
alter table work.space_resource force row level security;
alter table work.space_activity enable row level security;
alter table work.space_activity force row level security;

grant select, insert, update on work.space to legallabs_app;
-- A deleted Space is read by nobody: it has gone from every list.
create policy space_read on work.space for select to legallabs_app
  using (core.in_tenant(workspace_id) and deleted_at is null and work.space_role(id) is not null);
create policy space_insert on work.space for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and created_by = core.current_user_id()
              and core.has_permission('spaces.create')
              and (kind = 'internal' or core.has_permission('spaces.external'))
              and core.can_access_matter(matter_id));
create policy space_update on work.space for update to legallabs_app
  using (core.in_tenant(workspace_id) and work.space_role(id) = 'admin')
  with check (core.in_tenant(workspace_id) and core.can_access_matter(matter_id));

grant select, insert, update, delete on work.space_member to legallabs_app;
create policy member_read on work.space_member for select to legallabs_app
  using (core.in_tenant(workspace_id) and work.space_role(space_id) is not null);
create policy member_write on work.space_member for all to legallabs_app
  using (core.in_tenant(workspace_id) and work.space_role(space_id) = 'admin')
  with check (core.in_tenant(workspace_id) and work.space_role(space_id) = 'admin'
              and core.has_permission('spaces.invite'));

grant select, insert, update, delete on work.space_resource to legallabs_app;
create policy resource_read on work.space_resource for select to legallabs_app
  using (core.in_tenant(workspace_id) and work.space_role(space_id) is not null);
-- Whether the sharer holds Full on the resource is checked by the API, which can see the resource.
create policy resource_insert on work.space_resource for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and work.space_role(space_id) in ('admin', 'collaborator')
              and granted_by = core.current_user_id());
create policy resource_update on work.space_resource for update to legallabs_app
  using (core.in_tenant(workspace_id) and work.space_role(space_id) = 'admin')
  with check (core.in_tenant(workspace_id) and work.space_role(space_id) = 'admin');
create policy resource_delete on work.space_resource for delete to legallabs_app
  using (core.in_tenant(workspace_id)
         and (work.space_role(space_id) = 'admin' or granted_by = core.current_user_id()));

grant select, insert on work.space_activity to legallabs_app;
create policy activity_read on work.space_activity for select to legallabs_app
  using (core.in_tenant(workspace_id) and work.space_role(space_id) is not null);
create policy activity_insert on work.space_activity for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and work.space_role(space_id) is not null);

-- Direct and group grants only, never a Space's: onward sharing needs access that is the caller's own,
-- so a level a Space handed out can't be handed to another Space.
create function work.has_direct_access(object_type text, object_id uuid, level text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core.share_grant g join core."user" u
      on u.id = core.current_user_id() and u.workspace_id = g.workspace_id
     where g.object_type = has_direct_access.object_type
       and g.object_id = has_direct_access.object_id
       and g.workspace_id = core.current_workspace_id()
       and u.status = 'active'
       and g.suspended_reason is null
       and (g.expires_at is null or g.expires_at > now())
       and core.level_rank(g.level) >= core.level_rank(has_direct_access.level)
       and ((g.principal_type = 'user' and g.principal_id = u.id)
         or (g.principal_type = 'group' and exists (
               select 1 from core.group_member m
                where m.group_id = g.principal_id and m.user_id = u.id
                  and m.workspace_id = u.workspace_id))
         or (g.principal_type = 'workspace' and g.principal_id = u.workspace_id
             and u.kind = 'member')))
$$;
alter function work.has_direct_access(text, uuid, text) owner to legallabs_definer;
grant execute on function work.has_direct_access(text, uuid, text) to legallabs_app;

-- A Space grant adds to direct grants: a member reaches a shared resource at the best level either
-- gives them. Walls apply twice: the Space is dead to a walled member, and so is the resource.
create or replace function core.has_access(object_type text, object_id uuid, level text) returns boolean
language sql stable security definer set search_path = '' as $$
  with me as (
    select u.id, u.workspace_id, u.kind from core."user" u
     where u.id = core.current_user_id()
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active'
  )
  select exists (
    select 1 from core.share_grant g join me on g.workspace_id = me.workspace_id
     where g.object_type = has_access.object_type
       and g.object_id = has_access.object_id
       and g.suspended_reason is null
       and (g.expires_at is null or g.expires_at > now())
       -- An unknown level ranks as null, so the comparison fails closed.
       and core.level_rank(g.level) >= core.level_rank(has_access.level)
       and ((g.principal_type = 'user' and g.principal_id = me.id)
         or (g.principal_type = 'group' and exists (
               select 1 from core.group_member m
                where m.group_id = g.principal_id and m.user_id = me.id
                  and m.workspace_id = me.workspace_id))
         -- Guests reach content only through their Space, never a workspace-wide share.
         or (g.principal_type = 'workspace' and g.principal_id = me.workspace_id
             and me.kind = 'member')))
  or exists (
    select 1 from work.space_resource r join me on r.workspace_id = me.workspace_id
     where r.resource_type = has_access.object_type
       and r.resource_id = has_access.object_id
       and r.suspended_reason is null
       and core.level_rank(r.access) >= core.level_rank(has_access.level)
       and work.space_membership(r.space_id) is not null)
$$;
