-- Workflows (agents-workflows.md §4.8-4.11, §6). Permissions: agents.use (run and read
-- workflows shared with you), agents.build (create, edit, manage files), agents.admin (full
-- on every workflow). Admin's '*' holds all three. Sharing lives in core.share_grant
-- ('workflow'), ownership in owner_id (ADR-028). The pre-built catalogue is owned by no one.
create table work.workflow (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  owner_id uuid,
  title text not null check (char_length(title) between 1 and 120),
  description text check (char_length(description) <= 1000),
  practice_areas text[] not null default '{}' check (cardinality(practice_areas) <= 10),
  tags text[] not null default '{}' check (cardinality(tags) <= 20),
  notes text check (char_length(notes) <= 5000),
  status text not null default 'draft' check (status in ('draft', 'live')),
  -- What runs execute; moved only by publishing.
  live_version_id uuid,
  -- What editors work on; publishing promotes it and clears it.
  draft_version_id uuid,
  catalogue boolean not null default false,
  catalogue_key text check (char_length(catalogue_key) between 1 and 60),
  category text check (char_length(category) <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  unique (workspace_id, id),
  check ((owner_id is null) = catalogue),
  check (catalogue = (catalogue_key is not null)),
  check ((status = 'live') = (live_version_id is not null)),
  check ((deleted_at is null) = (deleted_by is null)),
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id),
  foreign key (workspace_id, deleted_by) references core."user" (workspace_id, id)
);
create unique index workflow_catalogue_key on work.workflow (workspace_id, catalogue_key)
  where catalogue;
create index workflow_list_idx on work.workflow (workspace_id, owner_id, deleted_at);

-- Versions are never changed, so a run always knows exactly what it ran (run.workflow_version_id).
-- The check is the coarse one Postgres can make; the API validates the whole definition.
create table work.workflow_version (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  workflow_id uuid not null,
  no integer not null check (no >= 1),
  definition jsonb not null check (
    definition ->> 'schema' = 'counsel.workflow/1'
    and jsonb_typeof(definition -> 'blocks') = 'array'
    and jsonb_typeof(definition -> 'edges') = 'array'
    and pg_column_size(definition) <= 1048576),
  validation jsonb not null default '{"errors": [], "warnings": []}'
    check (jsonb_typeof(validation) = 'object'),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (workflow_id, no),
  unique (workflow_id, id),
  unique (workspace_id, id),
  foreign key (workspace_id, workflow_id) references work.workflow (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id)
);

alter table work.workflow
  add foreign key (id, live_version_id) references work.workflow_version (workflow_id, id),
  add foreign key (id, draft_version_id) references work.workflow_version (workflow_id, id);

-- Even the owner role can't rewrite history: a run must find the definition it started on.
create function work.workflow_version_frozen() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'workflow versions never change' using errcode = '42501';
end
$$;
create trigger workflow_version_frozen before update on work.workflow_version
  for each row execute function work.workflow_version_frozen();

-- Embedded uploads belong to their workflow (§3.9, §6): one owner per document at most.
alter table content.document
  add column workflow_id uuid,
  add constraint document_one_owner check (num_nonnulls(vault_id, workflow_id) <= 1),
  add foreign key (workspace_id, workflow_id) references work.workflow (workspace_id, id);
create index document_workflow_idx on content.document (workflow_id)
  where workflow_id is not null;

-- A workflow run's form answers, kept on the run so a retried plan reads the same ones.
alter table work.run
  add column inputs jsonb check (inputs is null or jsonb_typeof(inputs) = 'object');

alter table work.workflow enable row level security;
alter table work.workflow force row level security;
alter table work.workflow_version enable row level security;
alter table work.workflow_version force row level security;

grant select, insert, update on work.workflow, work.workflow_version to legallabs_definer;
create policy definer_read on work.workflow for select to legallabs_definer using (true);
create policy definer_insert on work.workflow for insert to legallabs_definer
  with check (true);
create policy definer_write on work.workflow for update to legallabs_definer
  using (true) with check (true);
create policy definer_read on work.workflow_version for select to legallabs_definer
  using (true);
create policy definer_insert on work.workflow_version for insert to legallabs_definer
  with check (true);

/*
 * The caller's level on a workflow: full, edit, run, view, or null (not visible). One place for
 * the rule so every policy agrees. Nothing without agents.use; guests never. The catalogue is
 * view for everyone (duplicate to edit). Edit and full count only with agents.build.
 */
create function work.workflow_level(p_workflow uuid) returns text
language sql stable security definer set search_path = '' as $$
  with w as (
    select w.id, w.owner_id, w.catalogue from work.workflow w
     where w.id = p_workflow
       and w.workspace_id = core.current_workspace_id()
       and w.deleted_at is null
       and core.has_permission('agents.use')
       and exists (select 1 from core."user" u
                    where u.id = core.current_user_id()
                      and u.workspace_id = core.current_workspace_id()
                      and u.status = 'active' and u.kind = 'member')
  )
  select case
    when w.catalogue then 'view'
    when w.owner_id = core.current_user_id() then 'full'
    when core.has_permission('agents.admin') then 'full'
    when core.has_permission('agents.build') and core.has_access('workflow', w.id, 'full')
      then 'full'
    when core.has_permission('agents.build') and core.has_access('workflow', w.id, 'edit')
      then 'edit'
    when core.has_access('workflow', w.id, 'run') then 'run'
    when core.has_access('workflow', w.id, 'view') then 'view'
  end
    from w
$$;
alter function work.workflow_level(uuid) owner to legallabs_definer;
grant execute on function work.workflow_level(uuid) to legallabs_app, legallabs_definer;

grant select, insert on work.workflow to legallabs_app;
grant update (title, description, practice_areas, tags, notes, status, live_version_id,
              draft_version_id, updated_at)
  on work.workflow to legallabs_app;
create policy workflow_read on work.workflow for select to legallabs_app
  using (core.in_tenant(workspace_id) and deleted_at is null
         and work.workflow_level(id) is not null);
-- The catalogue is written by the seeder only.
create policy workflow_insert on work.workflow for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and owner_id = core.current_user_id()
              and not catalogue
              and status = 'draft'
              and live_version_id is null
              and deleted_at is null
              and core.has_permission('agents.use')
              and core.has_permission('agents.build'));
create policy workflow_update on work.workflow for update to legallabs_app
  using (core.in_tenant(workspace_id) and not catalogue
         and core.has_permission('agents.build')
         and work.workflow_level(id) in ('edit', 'full'))
  with check (core.in_tenant(workspace_id) and not catalogue);

grant select, insert on work.workflow_version to legallabs_app;
-- Runners see the live version, and the one each of their runs pinned even after a publish;
-- only viewers and editors see drafts.
create policy workflow_version_read on work.workflow_version for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (work.workflow_level(workflow_id) in ('view', 'edit', 'full')
              or (work.workflow_level(workflow_id) = 'run'
                  and (exists (select 1 from work.workflow w
                                where w.id = workflow_version.workflow_id
                                  and w.live_version_id = workflow_version.id)
                       or exists (select 1 from work.run r
                                   where r.workflow_version_id = workflow_version.id
                                     and r.owner_id = core.current_user_id())))));
create policy workflow_version_insert on work.workflow_version for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and created_by = core.current_user_id()
              and core.has_permission('agents.build')
              and work.workflow_level(workflow_id) in ('edit', 'full')
              and not exists (select 1 from work.workflow w
                               where w.id = workflow_version.workflow_id and w.catalogue));

-- A function, since the deleted row would no longer pass the read policy it is checked against.
create function work.delete_workflow(p_workflow uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if work.workflow_level(p_workflow) is distinct from 'full'
     or exists (select 1 from work.workflow w where w.id = p_workflow and w.catalogue) then
    return false;
  end if;
  update work.workflow set deleted_at = now(), deleted_by = core.current_user_id(),
                           updated_at = now()
   where id = p_workflow;
  return true;
end
$$;
alter function work.delete_workflow(uuid) owner to legallabs_definer;
grant execute on function work.delete_workflow(uuid) to legallabs_app;

-- Removing an embedded file: the API first checks no block still uses it (409 FILE_IN_USE).
create function work.remove_workflow_file(p_workflow uuid, p_document uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if work.workflow_level(p_workflow) not in ('edit', 'full')
     or not core.has_permission('agents.build') then
    return false;
  end if;
  update content.document
     set deleted_at = now(), deleted_by = core.current_user_id(), deleted_reason = 'user'
   where id = p_document and workflow_id = p_workflow and deleted_at is null;
  return found;
end
$$;
alter function work.remove_workflow_file(uuid, uuid) owner to legallabs_definer;
grant execute on function work.remove_workflow_file(uuid, uuid) to legallabs_app;

/*
 * Seeds or refreshes the catalogue in one workspace from `p_items` ([{key, title, description,
 * category, definition}]). Idempotent: an unchanged item is left alone, a changed one gets a
 * new live version. Only the server's own worker role may call it, so no person can write
 * a "system" workflow.
 */
create function work.seed_workflow_catalogue(p_workspace uuid, p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  item jsonb;
  wf work.workflow;
  live jsonb;
  version_id uuid;
  changed integer := 0;
begin
  for item in select * from jsonb_array_elements(p_items) loop
    select * into wf from work.workflow w
     where w.workspace_id = p_workspace and w.catalogue and w.catalogue_key = item ->> 'key';
    if wf.id is null then
      insert into work.workflow (workspace_id, owner_id, title, description, catalogue,
                                 catalogue_key, category)
      values (p_workspace, null, item ->> 'title', item ->> 'description', true,
              item ->> 'key', item ->> 'category')
      returning * into wf;
    end if;
    select v.definition into live from work.workflow_version v where v.id = wf.live_version_id;
    if live is distinct from item -> 'definition' then
      insert into work.workflow_version (workspace_id, workflow_id, no, definition)
      values (p_workspace, wf.id,
              coalesce((select max(v.no) from work.workflow_version v
                         where v.workflow_id = wf.id), 0) + 1,
              item -> 'definition')
      returning id into version_id;
      update work.workflow set live_version_id = version_id, status = 'live',
                               updated_at = now()
       where id = wf.id;
      changed := changed + 1;
    end if;
    update work.workflow
       set title = item ->> 'title', description = item ->> 'description',
           category = item ->> 'category', updated_at = now()
     where id = wf.id
       and (title, description, category) is distinct from
           (item ->> 'title', item ->> 'description', item ->> 'category');
  end loop;
  return changed;
end
$$;
alter function work.seed_workflow_catalogue(uuid, jsonb) owner to legallabs_definer;
revoke execute on function work.seed_workflow_catalogue(uuid, jsonb) from public;
grant execute on function work.seed_workflow_catalogue(uuid, jsonb) to legallabs_worker;

-- Who sees a document: as before, plus a workflow's embedded files for anyone who can read
-- the workflow (they are run as its context).
drop policy document_read on content.document;
create policy document_read on content.document for select to legallabs_app
  using (workspace_id = core.current_workspace_id()
         and (select core.is_active_member())
         and deleted_at is null
         and (matter_id is null
              or matter_id = any ((select content.accessible_matters())::uuid[]))
         and case when vault_id is not null
                    then vault_id = any ((select content.readable_vaults('view'))::uuid[])
                  when workflow_id is not null
                    then work.workflow_level(workflow_id) is not null
                  else owner_id = core.current_user_id() end);

drop policy document_insert on content.document;
create policy document_insert on content.document for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and owner_id = core.current_user_id()
              and deleted_at is null
              and core.can_access_matter(matter_id)
              and core.has_permission('threads.use')
              and (parent_id is null or content.parent_fits(parent_id, matter_id, vault_id))
              and (vault_id is null or (
                vault_id = any ((select content.readable_vaults('edit'))::uuid[])
                and exists (select 1 from content.vault v
                             where v.id = document.vault_id
                               and (v.matter_id is null
                                    or v.matter_id = document.matter_id))))
              and (workflow_id is null or (
                core.has_permission('agents.build')
                and work.workflow_level(workflow_id) in ('edit', 'full'))));

-- Replacing an embedded file adds a version, which editors of the workflow may do.
create or replace function content.can_write_document(p_document uuid) returns boolean
language plpgsql stable set search_path = '' as $$
begin
  return exists (
    select 1 from content.document d
     where d.id = p_document
       and case when d.vault_id is not null
                  then d.vault_id = any (content.readable_vaults('edit'))
                when d.workflow_id is not null
                  then core.has_permission('agents.build')
                       and work.workflow_level(d.workflow_id) in ('edit', 'full')
                else d.owner_id = core.current_user_id() end);
end
$$;
