create table core."group" (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  -- A party group holds the guests of one outside organisation, so walls can target them.
  kind text not null default 'standard' check (kind in ('standard', 'party')),
  visibility text not null default 'private' check (visibility in ('public', 'private')),
  scim_group_id text,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, name)
);

create table core.group_member (
  workspace_id uuid not null,
  group_id uuid not null,
  user_id uuid not null,
  added_at timestamptz not null default now(),
  primary key (group_id, user_id),
  foreign key (workspace_id, group_id) references core."group" (workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);
create index group_member_user_idx on core.group_member (workspace_id, user_id);

grant select on core."group", core.group_member to legallabs_definer;
create policy definer_read on core."group" for select to legallabs_definer using (true);
create policy definer_read on core.group_member for select to legallabs_definer using (true);

-- SECURITY DEFINER so group and member policies can check membership without recursing.
create function core.is_group_member(group_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core.group_member m
     where m.group_id = is_group_member.group_id
       and m.user_id = core.current_user_id()
       and m.workspace_id = core.current_workspace_id())
$$;
alter function core.is_group_member(uuid) owner to legallabs_definer;
grant execute on function core.is_group_member(uuid) to legallabs_app, legallabs_definer;

alter table core."group" enable row level security;
alter table core."group" force row level security;
alter table core.group_member enable row level security;
alter table core.group_member force row level security;

grant select, insert, update, delete on core."group" to legallabs_app;
create policy group_read on core."group" for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (visibility = 'public' or core.is_group_member(id) or core.has_permission('admin.users')));
create policy group_write on core."group" for all to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.users'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.users'));

grant select, insert, delete on core.group_member to legallabs_app;
create policy group_member_read on core.group_member for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (user_id = core.current_user_id() or core.is_group_member(group_id)
              or core.has_permission('admin.users')));
create policy group_member_write on core.group_member for all to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.users'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.users'));
