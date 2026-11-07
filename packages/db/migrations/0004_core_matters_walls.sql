create table core.matter (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  client_id text not null check (char_length(client_id) between 1 and 64),
  client_name text not null check (char_length(client_name) between 1 and 200),
  -- The client's own reference; named apart from the matter_id foreign keys elsewhere.
  matter_number text not null check (char_length(matter_number) between 1 and 64),
  matter_name text not null check (char_length(matter_name) between 1 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  wall_mode text not null default 'open' check (wall_mode in ('open', 'allow_list')),
  notice text check (char_length(notice) <= 5000),
  notice_version integer not null default 1 check (notice_version >= 1),
  allow_in_queries boolean not null default true,
  retention_hours integer check (retention_hours >= 3),
  require_walls_for_sharing boolean not null default false,
  status text not null default 'active' check (status in ('active', 'closed')),
  source text not null default 'manual'
    check (source in ('manual', 'csv', 'api', 'intapp', 'imanage')),
  external_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, client_id, matter_number)
);

create table core.wall (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  matter_id uuid not null,
  principal_type text not null check (principal_type in ('user', 'group')),
  principal_id uuid not null,
  effect text not null check (effect in ('allow', 'deny')),
  provider text not null default 'internal'
    check (provider in ('internal', 'csv', 'intapp', 'imanage_spm')),
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, matter_id) references core.matter (workspace_id, id) on delete cascade,
  unique (matter_id, principal_type, principal_id, effect, provider)
);
create index wall_principal_idx on core.wall (principal_type, principal_id);

create table core.matter_acknowledgement (
  workspace_id uuid not null,
  user_id uuid not null,
  matter_id uuid not null,
  notice_version integer not null,
  acknowledged_at timestamptz not null default now(),
  primary key (user_id, matter_id, notice_version),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade,
  foreign key (workspace_id, matter_id) references core.matter (workspace_id, id) on delete cascade
);

grant select on core.matter, core.wall to legallabs_definer;
create policy definer_read on core.matter for select to legallabs_definer using (true);
create policy definer_read on core.wall for select to legallabs_definer using (true);

-- A principal can point at a user or a group, so a plain foreign key cannot check it.
create function core.check_principal() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.principal_type = 'user' and exists (
        select 1 from core."user" u where u.id = new.principal_id and u.workspace_id = new.workspace_id))
     or (new.principal_type = 'group' and exists (
        select 1 from core."group" g where g.id = new.principal_id and g.workspace_id = new.workspace_id))
  then
    return new;
  end if;
  raise exception 'principal % % is not in this workspace', new.principal_type, new.principal_id
    using errcode = 'foreign_key_violation';
end
$$;
alter function core.check_principal() owner to legallabs_definer;

create trigger wall_principal before insert or update of workspace_id, principal_type, principal_id
  on core.wall for each row execute function core.check_principal();

-- The only definition of the wall rule. SECURITY DEFINER because wall rows are hidden from
-- the people they wall; read as the caller, every matter would look open.
create function core.can_access_matter(matter_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with me as (
    select u.id, u.workspace_id from core."user" u
     where u.id = core.current_user_id()
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active'
  ), principals as (
    select 'user' as type, me.id from me
    union all
    select 'group', m.group_id from core.group_member m
      join me on m.user_id = me.id and m.workspace_id = me.workspace_id
  )
  select case
    when not exists (select 1 from me) then false
    when can_access_matter.matter_id is null then true
    else coalesce((
      select not exists (
               select 1 from core.wall w join principals p
                 on w.principal_type = p.type and w.principal_id = p.id
                where w.matter_id = mt.id and w.effect = 'deny')
             and (mt.wall_mode = 'open' or exists (
               select 1 from core.wall w join principals p
                 on w.principal_type = p.type and w.principal_id = p.id
                where w.matter_id = mt.id and w.effect = 'allow'))
        from core.matter mt join me on mt.workspace_id = me.workspace_id
       where mt.id = can_access_matter.matter_id), false)
  end
$$;
alter function core.can_access_matter(uuid) owner to legallabs_definer;
grant execute on function core.can_access_matter(uuid) to legallabs_app, legallabs_definer;

alter table core.matter enable row level security;
alter table core.matter force row level security;
alter table core.wall enable row level security;
alter table core.wall force row level security;
alter table core.matter_acknowledgement enable row level security;
alter table core.matter_acknowledgement force row level security;

-- No delete: matters are closed, and closed matters keep enforcing their walls.
grant select, insert, update on core.matter to legallabs_app;
create policy matter_read on core.matter for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (core.can_access_matter(id) or core.has_permission('admin.matters')));
create policy matter_write on core.matter for all to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.matters'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.matters'));

grant select, insert, update, delete on core.wall to legallabs_app;
create policy wall_admin on core.wall for all to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.matters'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.matters'));

grant select, insert on core.matter_acknowledgement to legallabs_app;
create policy acknowledgement_read on core.matter_acknowledgement for select to legallabs_app
  using (core.in_tenant(workspace_id) and user_id = core.current_user_id());
create policy acknowledgement_insert on core.matter_acknowledgement for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and user_id = core.current_user_id()
              and core.can_access_matter(matter_id));
