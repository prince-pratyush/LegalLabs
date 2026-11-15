-- Playbooks (playbooks-word.md §4.1, §4.7, §6). Permissions: playbooks.use (read and run
-- reviews), playbooks.create (author: drafts and edits own), playbooks.manage (approver:
-- publishes, grants and deletes any). Admin's '*' holds all three.
create table work.playbook (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  owner_id uuid not null,
  -- Copies of the current version's, so the list can filter without opening versions.
  name text not null check (char_length(name) between 1 and 200),
  contract_type text not null check (char_length(contract_type) between 1 and 100),
  status text not null default 'unpublished' check (status in ('published', 'unpublished')),
  version_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Kept, not deleted, so reviews that ran against a version still find it.
  deleted_at timestamptz,
  deleted_by uuid,
  unique (workspace_id, id),
  check ((deleted_at is null) = (deleted_by is null)),
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id),
  foreign key (workspace_id, deleted_by) references core."user" (workspace_id, id)
);
create index playbook_list_idx on work.playbook (workspace_id, status, lower(contract_type))
  where deleted_at is null;

-- One rule title per playbook, ignoring case and outer spaces (§4.1).
create function work.rule_titles_unique(rules jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select count(distinct lower(btrim(r ->> 'title'))) = count(*)
    from jsonb_array_elements(rules) r
$$;
grant execute on function work.rule_titles_unique(jsonb) to legallabs_app;

-- Versions are never changed, so a review always knows exactly what it ran against.
create table work.playbook_version (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  playbook_id uuid not null,
  no integer not null check (no >= 1),
  name text not null check (char_length(name) between 1 and 200),
  contract_type text not null check (char_length(contract_type) between 1 and 100),
  guidance text check (char_length(guidance) <= 8000),
  rules jsonb not null check (jsonb_typeof(rules) = 'array'
                              and jsonb_array_length(rules) <= 200
                              and work.rule_titles_unique(rules)),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (playbook_id, no),
  unique (playbook_id, id),
  unique (workspace_id, id),
  foreign key (workspace_id, playbook_id) references work.playbook (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id)
);

-- Checked at commit, so a playbook and its first version can be written in one transaction.
alter table work.playbook
  add foreign key (id, version_id) references work.playbook_version (playbook_id, id)
    deferrable initially deferred;

create table work.playbook_grant (
  workspace_id uuid not null,
  playbook_id uuid not null,
  principal_type text not null check (principal_type in ('user', 'group')),
  principal_id uuid not null,
  level text not null check (level in ('view', 'edit', 'manage')),
  granted_by uuid not null,
  granted_at timestamptz not null default now(),
  primary key (playbook_id, principal_type, principal_id),
  foreign key (workspace_id, playbook_id) references work.playbook (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, granted_by) references core."user" (workspace_id, id)
);
create index playbook_grant_principal_idx on work.playbook_grant (principal_type, principal_id);

create trigger playbook_grant_principal
  before insert or update of workspace_id, principal_type, principal_id
  on work.playbook_grant for each row execute function core.check_principal();

alter table work.playbook enable row level security;
alter table work.playbook force row level security;
alter table work.playbook_version enable row level security;
alter table work.playbook_version force row level security;
alter table work.playbook_grant enable row level security;
alter table work.playbook_grant force row level security;

grant select on work.playbook, work.playbook_grant to legallabs_definer;
create policy definer_read on work.playbook for select to legallabs_definer using (true);
create policy definer_read on work.playbook_grant for select to legallabs_definer using (true);

-- The caller's level on a playbook: manage, edit, view or null (not visible).
--   * playbooks.manage (approver) manages every playbook in the workspace.
--   * The owner edits while they hold playbooks.create, but does not publish their own:
--     an approver does (author/approver split), unless the owner is also an approver.
--   * Grants to the user or a group they are in give that level.
--   * Visibility rule: an unpublished playbook is seen only at edit or manage. Once
--     published, every member with playbooks.use can view it, unless it has any `view`
--     grant: then view grants name its audience and only they (plus edit/manage) see it.
-- Guests never reach playbooks directly; Spaces will add their own path.
create function work.playbook_level(p_playbook uuid) returns text
language sql stable security definer set search_path = '' as $$
  with p as (
    select p.* from work.playbook p
     where p.id = p_playbook
       and p.workspace_id = core.current_workspace_id()
       and p.deleted_at is null
       and core.is_active_member()
       and exists (select 1 from core."user" u
                    where u.id = core.current_user_id() and u.kind = 'member')
  ), granted as (
    select max(core.level_rank(case g.level when 'manage' then 'full' else g.level end)) rank
      from work.playbook_grant g join p on g.playbook_id = p.id
     where (g.principal_type = 'user' and g.principal_id = core.current_user_id())
        or (g.principal_type = 'group' and core.is_group_member(g.principal_id))
  )
  select case
    when core.has_permission('playbooks.manage') then 'manage'
    when (select rank from granted) >= 4 then 'manage'
    when (select rank from granted) >= 3 then 'edit'
    when p.owner_id = core.current_user_id() and core.has_permission('playbooks.create')
      then 'edit'
    when p.status <> 'published' then null
    when (select rank from granted) >= 1 and core.has_permission('playbooks.use') then 'view'
    when core.has_permission('playbooks.use') and not exists (
      select 1 from work.playbook_grant g where g.playbook_id = p.id and g.level = 'view')
      then 'view'
  end
    from p
$$;
alter function work.playbook_level(uuid) owner to legallabs_definer;
grant execute on function work.playbook_level(uuid) to legallabs_app, legallabs_definer;

-- Publishing, deleting and handing over are approver actions; RLS can't see the old row.
create function work.playbook_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.status <> old.status or new.deleted_at is distinct from old.deleted_at)
     and work.playbook_level(old.id) is distinct from 'manage' then
    raise exception 'publishing or deleting a playbook needs manage' using errcode = '42501';
  end if;
  if new.owner_id <> old.owner_id and not core.has_permission('playbooks.manage') then
    raise exception 'only an approver can hand a playbook over' using errcode = '42501';
  end if;
  return new;
end
$$;
grant execute on function work.playbook_guard() to legallabs_app;
create trigger playbook_guard before update on work.playbook
  for each row execute function work.playbook_guard();

grant select, insert on work.playbook to legallabs_app;
grant update (name, contract_type, status, version_id, owner_id, updated_at)
  on work.playbook to legallabs_app;
create policy playbook_read on work.playbook for select to legallabs_app
  using (core.in_tenant(workspace_id) and deleted_at is null
         and work.playbook_level(id) is not null);
-- New playbooks start unpublished: an author's draft until an approver publishes it.
create policy playbook_insert on work.playbook for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and owner_id = core.current_user_id()
              and status = 'unpublished'
              and deleted_at is null
              and core.has_permission('playbooks.create'));
create policy playbook_update on work.playbook for update to legallabs_app
  using (core.in_tenant(workspace_id) and work.playbook_level(id) in ('edit', 'manage'))
  with check (core.in_tenant(workspace_id));

-- A function, since the deleted row would no longer pass the read policy it is checked against.
create function work.delete_playbook(p_playbook uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if work.playbook_level(p_playbook) is distinct from 'manage' then
    return false;
  end if;
  update work.playbook set deleted_at = now(), deleted_by = core.current_user_id()
   where id = p_playbook;
  return true;
end
$$;
grant update (deleted_at, deleted_by) on work.playbook to legallabs_definer;
create policy definer_delete on work.playbook for update to legallabs_definer
  using (true) with check (true);
alter function work.delete_playbook(uuid) owner to legallabs_definer;
grant execute on function work.delete_playbook(uuid) to legallabs_app;

grant select, insert on work.playbook_version to legallabs_app;
create policy playbook_version_read on work.playbook_version for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from work.playbook p where p.id = playbook_id));
-- The playbook row is written first, so even a new playbook's first version is checked here.
create policy playbook_version_insert on work.playbook_version for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and created_by = core.current_user_id()
              and work.playbook_level(playbook_id) in ('edit', 'manage'));

grant select, insert, delete on work.playbook_grant to legallabs_app;
create policy playbook_grant_read on work.playbook_grant for select to legallabs_app
  using (core.in_tenant(workspace_id) and work.playbook_level(playbook_id) is not null);
create policy playbook_grant_insert on work.playbook_grant for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and granted_by = core.current_user_id()
              and work.playbook_level(playbook_id) = 'manage');
create policy playbook_grant_delete on work.playbook_grant for delete to legallabs_app
  using (core.in_tenant(workspace_id) and work.playbook_level(playbook_id) = 'manage');
