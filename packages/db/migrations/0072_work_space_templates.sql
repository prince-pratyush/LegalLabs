-- A template is a Space's skeleton: phases, tasks, agent grants. Never its people or content.
create table work.space_template (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  owner_id uuid not null,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  -- counsel.space-template/1; the API validates the shape.
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  -- {workspace: boolean, group_ids: uuid[]}: private to the owner until shared.
  shared_to jsonb not null default '{"workspace": false, "group_ids": []}'
    check (jsonb_typeof(shared_to) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id)
);

-- Whether a template is shared with the caller's groups; run as definer so groups can stay private.
create function work.template_shared_with_me(shared jsonb) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((shared ->> 'workspace')::boolean, false)
      or exists (
        select 1 from core.group_member g, jsonb_array_elements_text(shared -> 'group_ids') ids(id)
         where g.user_id = core.current_user_id()
           and g.workspace_id = core.current_workspace_id()
           and g.group_id = ids.id::uuid)
$$;
alter function work.template_shared_with_me(jsonb) owner to legallabs_definer;
grant execute on function work.template_shared_with_me(jsonb) to legallabs_app;

alter table work.space_template enable row level security;
alter table work.space_template force row level security;
grant select, insert, update, delete on work.space_template to legallabs_app;
create policy template_read on work.space_template for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (owner_id = core.current_user_id() or work.template_shared_with_me(shared_to)));
create policy template_write on work.space_template for all to legallabs_app
  using (core.in_tenant(workspace_id) and owner_id = core.current_user_id()
         and core.has_permission('spaces.templates'))
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id()
              and core.has_permission('spaces.templates'));

-- A person who can see a Space through its matter, but is not in it, asks to join.
create table work.space_access_request (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  space_id uuid not null,
  user_id uuid not null,
  message text not null default '' check (char_length(message) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'denied')),
  decided_by uuid,
  decided_at timestamptz,
  reason text check (char_length(reason) <= 1000),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, space_id) references work.space (workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);
create unique index space_access_pending_idx on work.space_access_request (space_id, user_id)
  where status = 'pending';

-- What the Work-in picker may list. A Space whose matter walls the caller is absent altogether;
-- one they can reach by matter but are not in shows locked, so they can ask to join.
create function work.space_directory(p_query text default null)
returns table (id uuid, name text, kind text, matter_id uuid, locked boolean)
language sql stable security definer set search_path = '' as $$
  select s.id, s.name, s.kind, s.matter_id, work.space_role(s.id) is null
    from work.space s
   where s.workspace_id = core.current_workspace_id()
     and s.deleted_at is null
     and core.is_active_member()
     and core.can_access_matter(s.matter_id)
     and (p_query is null or s.name ilike '%' || replace(replace(p_query, '%', '\%'), '_', '\_') || '%')
   order by s.name
   limit 200
$$;
alter function work.space_directory(text) owner to legallabs_definer;
grant execute on function work.space_directory(text) to legallabs_app;

alter table work.space_access_request enable row level security;
alter table work.space_access_request force row level security;
grant select, insert, update on work.space_access_request to legallabs_app;
create policy access_read on work.space_access_request for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (user_id = core.current_user_id() or work.space_role(space_id) = 'admin'));
-- Only for a Space the caller can see in the directory, so a walled Space can't be probed.
create policy access_insert on work.space_access_request for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and user_id = core.current_user_id()
              and exists (select 1 from work.space_directory() d where d.id = space_id));
create policy access_decide on work.space_access_request for update to legallabs_app
  using (core.in_tenant(workspace_id) and work.space_role(space_id) = 'admin')
  with check (core.in_tenant(workspace_id) and work.space_role(space_id) = 'admin');

-- Whether a vault exists but its matter walls the caller, so a template can say why it skipped it.
create function work.vault_walled(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from content.vault v
                  where v.id = p_id and v.workspace_id = core.current_workspace_id()
                    and not core.can_access_matter(v.matter_id))
$$;
alter function work.vault_walled(uuid) owner to legallabs_definer;
grant execute on function work.vault_walled(uuid) to legallabs_app;

-- The people to tell about a request to join: a requester can't read a Space's members, so this
-- answers for any Space the caller can see in the directory.
create function work.space_admin_ids(p_space uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.principal_id
    from work.space_member m
   where m.space_id = p_space
     and m.role = 'admin' and m.principal_type = 'user'
     and m.workspace_id = core.current_workspace_id()
     and exists (select 1 from work.space_directory() d where d.id = p_space)
$$;
alter function work.space_admin_ids(uuid) owner to legallabs_definer;
grant execute on function work.space_admin_ids(uuid) to legallabs_app;
