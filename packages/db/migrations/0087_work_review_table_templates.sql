-- A review-table template keeps a table's columns, instructions and settings, never its rows,
-- cells or source. Sharing goes through core.share_grant ('template'), as the Library's does,
-- and only through the functions below; a template reaches everyone only once it is approved.
create table work.rt_template (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  owner_id uuid not null,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  instructions text not null default '' check (char_length(instructions) <= 4000),
  categories text[] not null default '{}' check (cardinality(categories) <= 20),
  document_tags text[] not null default '{}' check (cardinality(document_tags) <= 20),
  columns jsonb not null default '[]'
    check (jsonb_typeof(columns) = 'array' and jsonb_array_length(columns) <= 500),
  settings jsonb not null default '{}' check (jsonb_typeof(settings) = 'object'),
  status text not null default 'draft'
    check (status in ('draft', 'tested', 'shared', 'pending_approval', 'published', 'rejected',
                      'superseded')),
  version integer not null default 1 check (version >= 1),
  -- Editing a published template makes a new draft that points back at it; the published one
  -- keeps serving until the draft is approved.
  parent_id uuid,
  builtin boolean not null default false,
  approved_by uuid,
  approved_at timestamptz,
  rejected_note text check (char_length(rejected_note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id),
  foreign key (workspace_id, approved_by) references core."user" (workspace_id, id),
  foreign key (workspace_id, parent_id) references work.rt_template (workspace_id, id)
    on delete set null (parent_id)
);
create index rt_template_status_idx on work.rt_template (workspace_id, status)
  where deleted_at is null;

-- A table made to try a template out on a few files; it is deleted after seven days.
alter table work.review_table
  add column is_test boolean not null default false,
  add column template_id uuid;
alter table work.review_table
  add foreign key (workspace_id, template_id) references work.rt_template (workspace_id, id)
    on delete set null (template_id);

alter table work.rt_template enable row level security;
alter table work.rt_template force row level security;

grant select on work.rt_template to legallabs_app;
-- Status, approval and sharing change only through the functions below.
grant insert (id, workspace_id, owner_id, name, description, instructions, categories,
              document_tags, columns, settings, version, parent_id)
  on work.rt_template to legallabs_app;
grant update (name, description, instructions, categories, document_tags, columns, settings,
              updated_at, deleted_at)
  on work.rt_template to legallabs_app;

-- Owners and people it is shared with see a template; library.manage sees all; a published
-- one is open to every member. A deleted one still passes this check, because the update that
-- deletes it must leave a row the policy accepts; the API and the functions below leave
-- deleted templates out.
create policy rt_template_read on work.rt_template for select to legallabs_app
  using (core.in_tenant(workspace_id) and library.is_member()
         and (owner_id = core.current_user_id()
              or core.has_access('template', id, 'view')
              or core.has_permission('library.manage')
              or status = 'published'));
create policy rt_template_insert on work.rt_template for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and owner_id = core.current_user_id()
              and core.has_permission('tables.create'));
create policy rt_template_update on work.rt_template for update to legallabs_app
  using (core.in_tenant(workspace_id) and library.is_member()
         and (owner_id = core.current_user_id()
              or core.has_access('template', id, 'edit')
              or core.has_permission('library.manage')))
  with check (core.in_tenant(workspace_id));

grant select, update (status, approved_by, approved_at, rejected_note, updated_at)
  on work.rt_template to legallabs_definer;
create policy definer_all on work.rt_template for all to legallabs_definer
  using (workspace_id = core.current_workspace_id())
  with check (workspace_id = core.current_workspace_id());

/*
 * Moves a template along its lifecycle. Its owner, or anyone who may edit it, marks it tested or
 * shared and asks for approval; only library.manage approves or rejects what is waiting.
 * A newly approved revision retires the version it replaces.
 */
create function work.rt_template_set_status(p_id uuid, p_status text, p_note text default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  me uuid := core.current_user_id();
  t work.rt_template;
  manager boolean := core.has_permission('library.manage');
  editor boolean;
begin
  select * into t from work.rt_template x
   where x.id = p_id and x.workspace_id = ws and x.deleted_at is null;
  -- Someone who couldn't see the template is told it isn't there, not that they may not.
  if not found or not core.in_tenant(ws) or not library.is_member()
     or not (t.owner_id = me or core.has_access('template', t.id, 'view') or manager
             or t.status = 'published') then
    raise exception 'NOT_FOUND' using errcode = 'no_data_found';
  end if;
  editor := t.owner_id = me or core.has_access('template', t.id, 'edit') or manager;
  if p_status in ('published', 'rejected') then
    if not manager then
      raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
    end if;
    if t.status <> 'pending_approval' then
      raise exception 'BAD_TRANSITION' using errcode = 'check_violation';
    end if;
  elsif p_status in ('tested', 'shared') then
    if not editor then
      raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
    end if;
    if t.status not in ('draft', 'tested', 'shared', 'rejected') then
      raise exception 'BAD_TRANSITION' using errcode = 'check_violation';
    end if;
  elsif p_status = 'pending_approval' then
    if not editor then
      raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
    end if;
    if t.status not in ('tested', 'shared') then
      raise exception 'BAD_TRANSITION' using errcode = 'check_violation';
    end if;
  else
    raise exception 'BAD_TRANSITION' using errcode = 'check_violation';
  end if;

  update work.rt_template x
     set status = p_status, updated_at = now(),
         approved_by = case when p_status = 'published' then me else x.approved_by end,
         approved_at = case when p_status = 'published' then now() else x.approved_at end,
         rejected_note = case when p_status = 'rejected' then left(p_note, 1000) else null end
   where x.id = p_id;
  if p_status = 'published' and t.parent_id is not null then
    update work.rt_template x set status = 'superseded', updated_at = now()
     where x.id = t.parent_id and x.status = 'published';
  end if;
  return p_status;
end
$$;
alter function work.rt_template_set_status(uuid, text, text) owner to legallabs_definer;
grant execute on function work.rt_template_set_status(uuid, text, text) to legallabs_app;

/*
 * Replaces a template's shares with `p_grants` ([{principal_type, principal_id, level}], level
 * 'use' or 'edit') and reports each change. Only the owner or library.manage may share, and
 * only library.manage may share with the whole workspace.
 */
create function work.rt_template_set_shares(p_id uuid, p_grants jsonb)
returns table (principal_type text, principal_id uuid, level text, change text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
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
  select t.owner_id into owner from work.rt_template t
   where t.id = p_id and t.workspace_id = ws and t.deleted_at is null;
  if owner is null or not core.in_tenant(ws) then
    raise exception 'NOT_FOUND' using errcode = 'no_data_found';
  end if;
  if owner <> me and not core.has_permission('library.manage') then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_grants) is distinct from 'array' or jsonb_array_length(p_grants) > 100 then
    raise exception 'INVALID_GRANTS' using errcode = 'invalid_parameter_value';
  end if;

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
     where s.object_type = 'template' and s.object_id = p_id and s.workspace_id = ws
     order by s.granted_at, s.id
  loop
    if array_position(keys, kind || ':' || who) is null then
      delete from core.share_grant s
       where s.object_type = 'template' and s.object_id = p_id and s.workspace_id = ws
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
     where s.object_type = 'template' and s.object_id = p_id and s.workspace_id = ws
       and s.principal_type = kind and s.principal_id = who;
    if had is null then
      insert into core.share_grant (workspace_id, object_type, object_id, principal_type,
                                    principal_id, level, granted_by)
      values (ws, 'template', p_id, kind, who, want, me);
      change := 'added';
    elsif had <> want then
      update core.share_grant s set level = want
       where s.object_type = 'template' and s.object_id = p_id and s.workspace_id = ws
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
alter function work.rt_template_set_shares(uuid, jsonb) owner to legallabs_definer;
grant execute on function work.rt_template_set_shares(uuid, jsonb) to legallabs_app;

-- A template's shares with readable names, for its owner or library.manage.
create function work.rt_template_shares(p_id uuid)
returns table (principal_type text, principal_id uuid, label text, level text)
language sql stable security definer set search_path = '' as $$
  select g.principal_type, g.principal_id,
         coalesce(nullif(u.name, ''), u.email, gr.name, 'Everyone'),
         case g.level when 'view' then 'use' else g.level end
    from core.share_grant g
    left join core."user" u on g.principal_type = 'user' and u.id = g.principal_id
    left join core."group" gr on g.principal_type = 'group' and gr.id = g.principal_id
   where g.workspace_id = core.current_workspace_id()
     and g.object_type = 'template' and g.object_id = p_id
     and core.in_tenant(g.workspace_id)
     and (core.has_permission('library.manage') or exists (
           select 1 from work.rt_template t
            where t.id = p_id and t.owner_id = core.current_user_id()))
   order by g.granted_at, g.id
$$;
alter function work.rt_template_shares(uuid) owner to legallabs_definer;
grant execute on function work.rt_template_shares(uuid) to legallabs_app;

-- Test tables go after seven days. Only the worker role calls this.
create function work.rt_expire_tests() returns integer
language sql security definer set search_path = '' as $$
  with gone as (
    update work.review_table t set deleted_at = now()
     where t.is_test and t.deleted_at is null and t.created_at < now() - interval '7 days'
    returning 1)
  select count(*)::int from gone
$$;
grant select (is_test, created_at), update (deleted_at) on work.review_table
  to legallabs_definer;
create policy definer_expire on work.review_table for update to legallabs_definer
  using (is_test) with check (is_test);
alter function work.rt_expire_tests() owner to legallabs_definer;
revoke execute on function work.rt_expire_tests() from public;
grant execute on function work.rt_expire_tests() to legallabs_worker;
