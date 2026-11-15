-- The Library: saved prompts and firm document templates, shared like everything else
-- through core.share_grant ('library_item' for prompts, 'template' for templates).
create schema library;
grant usage on schema library to legallabs_app, legallabs_definer;

create table library.prompt (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  owner_id uuid not null,
  name text not null check (char_length(name) between 1 and 120),
  description text check (char_length(description) <= 500),
  body text not null check (char_length(body) between 1 and 8000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id)
);
create index prompt_recent_idx on library.prompt (workspace_id, updated_at desc);

create table library.template (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  owner_id uuid not null,
  name text not null check (char_length(name) between 1 and 120),
  description text check (char_length(description) <= 500),
  instructions text check (char_length(instructions) <= 4000),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id)
);
create index template_recent_idx on library.template (workspace_id, updated_at desc);
-- One default per workspace; exports use it when the user picks nothing.
create unique index template_one_default on library.template (workspace_id) where is_default;

-- Versions are never changed. A revert adds a new version, so history stays in order.
-- Bytes live here, not in the object store, so a template is gone when its row is.
create table library.template_version (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  template_id uuid not null,
  no integer not null check (no >= 1),
  file_name text not null check (char_length(file_name) between 1 and 255),
  bytes bytea not null check (octet_length(bytes) between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  placeholders text[] not null default '{}' check (cardinality(placeholders) <= 200),
  note text check (char_length(note) <= 500),
  reverted_from integer check (reverted_from >= 1),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (template_id, no),
  unique (workspace_id, id),
  foreign key (workspace_id, template_id) references library.template (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id)
);

-- Guests reach nothing in the Library, even through a group they belong to.
create function library.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core."user" u
     where u.id = core.current_user_id()
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active' and u.kind = 'member')
$$;
alter function library.is_member() owner to legallabs_definer;
grant execute on function library.is_member() to legallabs_app, legallabs_definer;

alter table library.prompt enable row level security;
alter table library.prompt force row level security;
alter table library.template enable row level security;
alter table library.template force row level security;
alter table library.template_version enable row level security;
alter table library.template_version force row level security;

-- Owners and grants edit the words; the owner and sharing change only through functions.
grant select, insert, delete on library.prompt to legallabs_app;
grant select, delete on library.template to legallabs_app;
-- Not is_default: the default changes only through library.set_default_template.
grant insert (id, workspace_id, owner_id, name, description, instructions, created_at, updated_at)
  on library.template to legallabs_app;
grant update (name, description, body, updated_at) on library.prompt to legallabs_app;
grant update (name, description, instructions, updated_at) on library.template to legallabs_app;
grant select, insert on library.template_version to legallabs_app;

-- library.manage sees and manages everything; others see their own and what's shared.
create policy prompt_read on library.prompt for select to legallabs_app
  using (core.in_tenant(workspace_id) and library.is_member()
         and (owner_id = core.current_user_id()
              or core.has_access('library_item', id, 'view')
              or core.has_permission('library.manage')));
create policy prompt_insert on library.prompt for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and owner_id = core.current_user_id()
              and core.has_permission('threads.use'));
create policy prompt_update on library.prompt for update to legallabs_app
  using (core.in_tenant(workspace_id) and library.is_member()
         and (owner_id = core.current_user_id()
              or core.has_access('library_item', id, 'edit')
              or core.has_permission('library.manage')))
  with check (core.in_tenant(workspace_id));
create policy prompt_delete on library.prompt for delete to legallabs_app
  using (core.in_tenant(workspace_id) and library.is_member()
         and (owner_id = core.current_user_id() or core.has_permission('library.manage')));

-- The default template is usable by anyone who can draft, without a share.
create policy template_read on library.template for select to legallabs_app
  using (core.in_tenant(workspace_id) and library.is_member()
         and (owner_id = core.current_user_id()
              or core.has_access('template', id, 'view')
              or core.has_permission('library.manage')
              or (is_default and core.has_permission('threads.use'))));
-- Firm templates are curated: only library.manage uploads them.
create policy template_insert on library.template for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and owner_id = core.current_user_id()
              and core.has_permission('library.manage'));
create policy template_update on library.template for update to legallabs_app
  using (core.in_tenant(workspace_id) and library.is_member()
         and (owner_id = core.current_user_id()
              or core.has_access('template', id, 'edit')
              or core.has_permission('library.manage')))
  with check (core.in_tenant(workspace_id));
create policy template_delete on library.template for delete to legallabs_app
  using (core.in_tenant(workspace_id) and library.is_member()
         and (owner_id = core.current_user_id() or core.has_permission('library.manage')));

create policy template_version_read on library.template_version for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from library.template t where t.id = template_id));
create policy template_version_insert on library.template_version for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and created_by = core.current_user_id()
              and exists (
                select 1 from library.template t
                 where t.id = template_id
                   and (t.owner_id = core.current_user_id()
                        or core.has_access('template', t.id, 'edit')
                        or core.has_permission('library.manage'))));

-- Library items are shared only through library.set_shares, which checks who may share.
drop policy share_grant_insert on core.share_grant;
create policy share_grant_insert on core.share_grant for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and granted_by = core.current_user_id()
              and object_type not in ('thread', 'vault', 'library_item', 'template'));
drop policy share_grant_delete on core.share_grant;
create policy share_grant_delete on core.share_grant for delete to legallabs_app
  using (core.in_tenant(workspace_id)
         and object_type not in ('thread', 'vault', 'library_item', 'template')
         and (granted_by = core.current_user_id() or core.has_permission('admin.config')));

grant select on library.prompt, library.template to legallabs_definer;
create policy definer_read on library.prompt for select to legallabs_definer
  using (workspace_id = core.current_workspace_id());
create policy definer_read on library.template for select to legallabs_definer
  using (workspace_id = core.current_workspace_id());
grant update (is_default, updated_at) on library.template to legallabs_definer;
create policy definer_update on library.template for update to legallabs_definer
  using (workspace_id = core.current_workspace_id())
  with check (workspace_id = core.current_workspace_id());

-- A deleted item's grants go with it, so an id can never be reshared by accident.
create function library.drop_grants() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from core.share_grant g
   where g.object_type = tg_argv[0] and g.object_id = old.id
     and g.workspace_id = old.workspace_id;
  return old;
end
$$;
alter function library.drop_grants() owner to legallabs_definer;
create trigger prompt_drop_grants after delete on library.prompt
  for each row execute function library.drop_grants('library_item');
create trigger template_drop_grants after delete on library.template
  for each row execute function library.drop_grants('template');

/*
 * Replaces an item's shares with `grants` ([{principal_type, principal_id, level}], level
 * 'use' or 'edit') and reports each change. Only the owner or library.manage may share,
 * and only library.manage may share with the whole workspace.
 */
create function library.set_shares(p_kind text, p_id uuid, p_grants jsonb)
returns table (principal_type text, principal_id uuid, level text, change text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  obj_type text := case p_kind when 'prompt' then 'library_item' when 'template' then 'template' end;
  ws uuid := core.current_workspace_id();
  me uuid := core.current_user_id();
  owner uuid;
  g jsonb;
  keys text[] := '{}';
  kinds text[] := '{}';
  whos uuid[] := '{}';
  levels text[] := '{}';
  at integer;
  want text;
  had text;
  kind text;
  who uuid;
begin
  if obj_type is null then
    raise exception 'unknown library kind %', p_kind using errcode = 'invalid_parameter_value';
  end if;
  if p_kind = 'prompt' then
    select p.owner_id into owner from library.prompt p where p.id = p_id and p.workspace_id = ws;
  else
    select t.owner_id into owner from library.template t where t.id = p_id and t.workspace_id = ws;
  end if;
  if owner is null or not core.in_tenant(ws) then
    raise exception 'NOT_FOUND' using errcode = 'no_data_found';
  end if;
  if owner <> me and not core.has_permission('library.manage') then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_grants) is distinct from 'array' or jsonb_array_length(p_grants) > 100 then
    raise exception 'INVALID_GRANTS' using errcode = 'invalid_parameter_value';
  end if;

  -- Checked and de-duplicated first, so a bad entry changes nothing.
  for g in select * from jsonb_array_elements(p_grants) loop
    want := case g->>'level' when 'use' then 'view' when 'edit' then 'edit' end;
    kind := g->>'principal_type';
    if want is null or kind is null or kind not in ('user', 'group', 'workspace')
       or coalesce(g->>'principal_id', '') !~ '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$' then
      raise exception 'INVALID_GRANTS' using errcode = 'invalid_parameter_value';
    end if;
    who := (g->>'principal_id')::uuid;
    if kind = 'workspace' and not core.has_permission('library.manage') then
      raise exception 'SHARING_RESTRICTED' using errcode = 'insufficient_privilege';
    end if;
    -- Guests reach nothing through the Library; a user grant must name a member.
    if kind = 'user' and not exists (
         select 1 from core."user" u
          where u.id = who and u.workspace_id = ws and u.status = 'active' and u.kind = 'member') then
      raise exception 'NOT_MEMBER' using errcode = 'foreign_key_violation';
    end if;
    at := array_position(keys, kind || ':' || who);
    if at is null then
      keys := keys || (kind || ':' || who);
      kinds := kinds || kind;
      whos := whos || who;
      levels := levels || want;
    else
      levels[at] := want;
    end if;
  end loop;

  for kind, who, had in
    select s.principal_type, s.principal_id, s.level from core.share_grant s
     where s.object_type = obj_type and s.object_id = p_id and s.workspace_id = ws
     order by s.granted_at, s.id
  loop
    if array_position(keys, kind || ':' || who) is null then
      delete from core.share_grant s
       where s.object_type = obj_type and s.object_id = p_id and s.workspace_id = ws
         and s.principal_type = kind and s.principal_id = who;
      principal_type := kind;
      principal_id := who;
      level := case had when 'view' then 'use' else had end;
      change := 'removed';
      return next;
    end if;
  end loop;

  for at in 1 .. coalesce(array_length(keys, 1), 0) loop
    kind := kinds[at];
    who := whos[at];
    want := levels[at];
    had := null;
    select s.level into had from core.share_grant s
     where s.object_type = obj_type and s.object_id = p_id and s.workspace_id = ws
       and s.principal_type = kind and s.principal_id = who;
    if had is null then
      insert into core.share_grant (workspace_id, object_type, object_id, principal_type,
                                    principal_id, level, granted_by)
      values (ws, obj_type, p_id, kind, who, want, me);
      change := 'added';
    elsif had <> want then
      update core.share_grant s set level = want
       where s.object_type = obj_type and s.object_id = p_id and s.workspace_id = ws
         and s.principal_type = kind and s.principal_id = who;
      change := 'changed';
    else
      change := 'kept';
    end if;
    principal_type := kind;
    principal_id := who;
    level := case want when 'view' then 'use' else want end;
    return next;
  end loop;
end
$$;
alter function library.set_shares(text, uuid, jsonb) owner to legallabs_definer;
grant execute on function library.set_shares(text, uuid, jsonb) to legallabs_app;
grant update (level) on core.share_grant to legallabs_definer;
create policy definer_update on core.share_grant for update to legallabs_definer
  using (workspace_id = core.current_workspace_id())
  with check (workspace_id = core.current_workspace_id());

-- An item's shares with readable names, for its owner or library.manage.
create function library.shares(p_kind text, p_id uuid)
returns table (principal_type text, principal_id uuid, label text, level text)
language sql stable security definer set search_path = '' as $$
  select g.principal_type, g.principal_id,
         coalesce(nullif(u.name, ''), u.email, gr.name, 'Everyone'),
         case g.level when 'view' then 'use' else g.level end
    from core.share_grant g
    left join core."user" u on g.principal_type = 'user' and u.id = g.principal_id
    left join core."group" gr on g.principal_type = 'group' and gr.id = g.principal_id
   where g.workspace_id = core.current_workspace_id()
     and g.object_type = case p_kind when 'prompt' then 'library_item' else 'template' end
     and g.object_id = p_id
     and core.in_tenant(g.workspace_id)
     and (core.has_permission('library.manage') or exists (
           select 1 from library.prompt p
            where p_kind = 'prompt' and p.id = p_id and p.owner_id = core.current_user_id()
           union all
           select 1 from library.template t
            where p_kind = 'template' and t.id = p_id and t.owner_id = core.current_user_id()))
   order by g.granted_at, g.id
$$;
alter function library.shares(text, uuid) owner to legallabs_definer;
grant execute on function library.shares(text, uuid) to legallabs_app;

-- Makes a template the workspace default (or clears it); library.manage only.
create function library.set_default_template(p_id uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
begin
  if not (core.in_tenant(ws) and core.has_permission('library.manage')) then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from library.template t where t.id = p_id and t.workspace_id = ws) then
    return false;
  end if;
  if p_on then
    update library.template t set is_default = false, updated_at = now()
     where t.workspace_id = ws and t.is_default and t.id <> p_id;
  end if;
  update library.template t set is_default = p_on, updated_at = now()
   where t.id = p_id and t.workspace_id = ws;
  return true;
end
$$;
alter function library.set_default_template(uuid, boolean) owner to legallabs_definer;
grant execute on function library.set_default_template(uuid, boolean) to legallabs_app;
