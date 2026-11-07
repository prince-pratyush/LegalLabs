-- Ownership is the object's owner_id, never a grant, so a transfer is one update.
create table core.share_grant (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  object_type text not null check (object_type in (
    'thread', 'vault', 'document', 'review_table', 'agent', 'workflow', 'playbook',
    'space', 'scan', 'library_item', 'template')),
  object_id uuid not null,
  principal_type text not null check (principal_type in ('user', 'group', 'space', 'workspace')),
  principal_id uuid not null,
  level text not null check (level in ('view', 'run', 'edit', 'full')),
  granted_by uuid not null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  suspended_reason text,
  foreign key (workspace_id, granted_by) references core."user" (workspace_id, id),
  unique (object_type, object_id, principal_type, principal_id)
);
create index share_grant_principal_idx on core.share_grant (principal_type, principal_id);

grant select on core.share_grant to legallabs_definer;
create policy definer_read on core.share_grant for select to legallabs_definer using (true);

create or replace function core.check_principal() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.principal_type = 'user' and exists (
        select 1 from core."user" u where u.id = new.principal_id and u.workspace_id = new.workspace_id))
     or (new.principal_type = 'group' and exists (
        select 1 from core."group" g where g.id = new.principal_id and g.workspace_id = new.workspace_id))
     or (new.principal_type = 'workspace' and new.principal_id = new.workspace_id)
  then
    return new;
  end if;
  -- Space principals are refused until the spaces table exists to check them against.
  raise exception 'principal % % is not in this workspace', new.principal_type, new.principal_id
    using errcode = 'foreign_key_violation';
end
$$;

create trigger share_grant_principal
  before insert or update of workspace_id, principal_type, principal_id
  on core.share_grant for each row execute function core.check_principal();

create function core.level_rank(level text) returns integer
language sql immutable as $$
  select case level when 'view' then 1 when 'run' then 2 when 'edit' then 3 when 'full' then 4 end
$$;
grant execute on function core.level_rank(text) to legallabs_app, legallabs_definer;

-- Answers for shares only; callers check the object's owner_id alongside it.
create function core.has_access(object_type text, object_id uuid, level text) returns boolean
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
$$;
alter function core.has_access(text, uuid, text) owner to legallabs_definer;
grant execute on function core.has_access(text, uuid, text) to legallabs_app, legallabs_definer;

alter table core.share_grant enable row level security;
alter table core.share_grant force row level security;

-- Whether the sharer may share the object is checked by the object's own module.
grant select, insert, delete on core.share_grant to legallabs_app;
create policy share_grant_read on core.share_grant for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (granted_by = core.current_user_id()
              or (principal_type = 'user' and principal_id = core.current_user_id())
              or (principal_type = 'group' and core.is_group_member(principal_id))
              or principal_type = 'workspace'));
create policy share_grant_insert on core.share_grant for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and granted_by = core.current_user_id());
create policy share_grant_delete on core.share_grant for delete to legallabs_app
  using (core.in_tenant(workspace_id)
         and (granted_by = core.current_user_id() or core.has_permission('admin.config')));
