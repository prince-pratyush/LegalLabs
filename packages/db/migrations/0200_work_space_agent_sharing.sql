-- Agents shared into Spaces (spaces-matters.md SPC-001, SPC-005; agents-workflows.md §4.6, §7).
-- A Space grant of an agent is held to: no Full, guests at Run only, a sharer with Full in their
-- own right, Space admin approval when the Space is external, and the walls of the matters the
-- agent's files belong to.

-- The matters of everything an agent's live and draft versions carry. Internal: never handed out,
-- since an agent may carry files of matters the caller must not learn of.
create function work.agent_matters(p_agent uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  with att as (
    select x ->> 'kind' as kind, (x ->> 'ref')::uuid as ref
      from work.agent a
      join work.agent_version v on v.agent_id = a.id
       and v.id in (a.live_version_id, a.draft_version_id)
     cross join lateral jsonb_array_elements(v.attachments) x
     where a.id = p_agent and a.workspace_id = core.current_workspace_id()
       and x ->> 'ref' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), vaults as (
    select att.ref as id from att where att.kind = 'vault'
    union
    select f.vault_id from att join content.folder f on f.id = att.ref
     where att.kind = 'vault_folder'
    union
    select t.vault_id from att join work.review_table t on t.id = att.ref
     where att.kind = 'review_table' and t.vault_id is not null
  ), found as (
    select v.matter_id from vaults join content.vault v on v.id = vaults.id
     where v.workspace_id = core.current_workspace_id()
    union
    select d.matter_id from vaults join content.document d on d.vault_id = vaults.id
     where d.workspace_id = core.current_workspace_id() and d.deleted_at is null
    union
    select d.matter_id from att join content.document d on d.id = att.ref
     where att.kind = 'upload' and d.workspace_id = core.current_workspace_id()
    union
    select v.matter_id from att
      join content.document d on d.id = att.ref
      join content.vault v on v.id = d.vault_id
     where att.kind = 'upload' and d.workspace_id = core.current_workspace_id()
    union
    select t.matter_id from att join work.review_table t on t.id = att.ref
     where att.kind = 'review_table' and t.workspace_id = core.current_workspace_id()
  )
  select matter_id from found where matter_id is not null
$$;
alter function work.agent_matters(uuid) owner to legallabs_definer;
revoke execute on function work.agent_matters(uuid) from public;
grant execute on function work.agent_matters(uuid) to legallabs_definer;
grant select on work.review_table, content.document, content.vault, content.folder, core.matter,
  core.group_member, core.share_grant, work.space_member to legallabs_definer;

-- How many people in a Space (guests included) are walled from a matter of the agent's files that
-- requires walls for sharing. A count, never who or which matter.
create function work.agent_space_blocked(p_space uuid, p_agent uuid) returns integer
language sql stable security definer set search_path = '' as $$
  with walled as (
    select m.id from core.matter m
     where m.workspace_id = core.current_workspace_id() and m.require_walls_for_sharing
       and m.id in (select work.agent_matters(p_agent))
  )
  select count(distinct person)::integer
    from work.space_member s
   cross join lateral core.grant_recipients(s.principal_type, s.principal_id) person
   cross join walled
   where s.space_id = p_space and s.workspace_id = core.current_workspace_id()
     and not core.user_can_access_matter(person, walled.id)
$$;
alter function work.agent_space_blocked(uuid, uuid) owner to legallabs_definer;
revoke execute on function work.agent_space_blocked(uuid, uuid) from public;
grant execute on function work.agent_space_blocked(uuid, uuid) to legallabs_definer;
grant execute on function core.grant_recipients(text, uuid),
  core.user_can_access_matter(uuid, uuid), core.can_access_matter(uuid),
  core.is_active_guest() to legallabs_definer;

-- A Space grant of an agent is dead while anyone in the Space is walled from such a matter, and
-- comes back when they are not: checked on every use, so new members, new walls and new files
-- all count.
create function work.agent_wall_closed(p_space uuid, p_agent uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select work.space_membership(p_space) is not null
     and work.agent_space_blocked(p_space, p_agent) > 0
$$;
alter function work.agent_wall_closed(uuid, uuid) owner to legallabs_definer;
grant execute on function work.agent_wall_closed(uuid, uuid) to legallabs_app, legallabs_definer;

-- What the API asks before sharing: another matter's files, and people a wall would block.
create function work.agent_share_check(p_space uuid, p_agent uuid)
returns table (other_matter boolean, blocked integer)
language sql stable security definer set search_path = '' as $$
  select exists (
           select 1 from work.space s, work.agent_matters(p_agent) m
            where s.id = p_space and s.matter_id is not null and m <> s.matter_id),
         work.agent_space_blocked(p_space, p_agent)
   where core.is_active_member() and work.space_role(p_space) is not null
$$;
alter function work.agent_share_check(uuid, uuid) owner to legallabs_definer;
grant execute on function work.agent_share_check(uuid, uuid) to legallabs_app;

-- Full on an agent in a person's own right: its owner, or a direct, group or workspace grant.
-- Never through a Space, so what one Space handed out can't be handed to another.
create function work.agent_full_by_right(p_agent uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with who as (
    select u.id, u.workspace_id, u.extra_permissions || coalesce(r.permissions, '{}') as perms
      from core."user" u
      left join core.role r on r.workspace_id = u.workspace_id and r.id = u.role_id
     where u.id = p_user and u.workspace_id = core.current_workspace_id()
       and u.status = 'active' and u.kind = 'member'
  )
  select exists (
    select 1 from work.agent a join who on a.workspace_id = who.workspace_id
     where a.id = p_agent and a.deleted_at is null
       and ((a.owner_id = who.id and who.perms && array['agents.use', '*'])
         or (who.perms && array['agents.build', '*'] and exists (
               select 1 from core.share_grant g
                where g.object_type = 'agent' and g.object_id = a.id
                  and g.workspace_id = who.workspace_id and g.level = 'full'
                  and g.suspended_reason is null
                  and (g.expires_at is null or g.expires_at > now())
                  and ((g.principal_type = 'user' and g.principal_id = who.id)
                    or (g.principal_type = 'workspace' and g.principal_id = who.workspace_id)
                    or (g.principal_type = 'group' and exists (
                          select 1 from core.group_member m
                           where m.group_id = g.principal_id and m.user_id = who.id
                             and m.workspace_id = who.workspace_id)))))))
$$;
alter function work.agent_full_by_right(uuid, uuid) owner to legallabs_definer;
revoke execute on function work.agent_full_by_right(uuid, uuid) from public;
grant execute on function work.agent_full_by_right(uuid, uuid) to legallabs_definer;

-- The caller's own, which is all the app role may ask about.
create function work.my_agent_full(p_agent uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select work.agent_full_by_right(p_agent, core.current_user_id())
$$;
alter function work.my_agent_full(uuid) owner to legallabs_definer;
grant execute on function work.my_agent_full(uuid) to legallabs_app, legallabs_definer;

-- What a guest party given Run sees of an agent: its title and nothing else. The description can
-- be written from the instructions, so it stays inside. Hidden when walled from any of its files.
create function work.guest_agent_title(p_agent uuid) returns text
language sql stable security definer set search_path = '' as $$
  select a.title from work.agent a
   where a.id = p_agent and a.workspace_id = core.current_workspace_id() and a.deleted_at is null
     and core.is_active_guest() and core.has_access('agent', a.id, 'run')
     and not exists (select 1 from work.agent_matters(a.id) m where not core.can_access_matter(m))
$$;
alter function work.guest_agent_title(uuid) owner to legallabs_definer;
grant execute on function work.guest_agent_title(uuid) to legallabs_app;
grant execute on function core.has_access(text, uuid, text) to legallabs_definer;

-- As 0161, with the agent wall on the Space branch.
create or replace function core.has_access(object_type text, object_id uuid, level text) returns boolean
language sql stable security definer set search_path = '' as $$
  with me as (
    select u.id, u.workspace_id, u.kind from core."user" u
     where u.id = core.current_user_id()
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active'
       and (u.kind <> 'guest' or core.guest_live(u.id))
  )
  select exists (
    select 1 from core.share_grant g join me on g.workspace_id = me.workspace_id
     where me.kind <> 'guest'
       and g.object_type = has_access.object_type
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
         or (g.principal_type = 'workspace' and g.principal_id = me.workspace_id
             and me.kind = 'member')))
  or exists (
    select 1 from work.space_resource r join me on r.workspace_id = me.workspace_id
     where r.resource_type = has_access.object_type
       and r.resource_id = has_access.object_id
       and r.suspended_reason is null
       and core.level_rank(case when me.kind = 'guest' then work.guest_level(r.space_id, r.per_party)
                                else r.access end)
           >= core.level_rank(has_access.level)
       and work.space_membership(r.space_id) is not null
       and (r.resource_type <> 'agent' or not work.agent_wall_closed(r.space_id, r.resource_id)))
$$;

-- The rules on an agent's Space grant, whatever route writes it. The approval function below
-- writes as the definer, after making the approval's own checks.
create function work.guard_agent_resource() returns trigger
language plpgsql as $$
declare
  raised boolean;
begin
  if new.resource_type <> 'agent' then
    return new;
  end if;
  if new.access = 'full' then
    raise exception 'AGENT_LEVEL_INVALID' using errcode = 'check_violation';
  end if;
  if exists (select 1 from jsonb_each_text(new.per_party) p where p.value not in ('none', 'run')) then
    raise exception 'INVALID_PARTY_LEVEL' using errcode = 'check_violation';
  end if;
  if current_user <> 'legallabs_app' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raised := true;
  else
    if (new.resource_type, new.resource_id, new.space_id)
       is distinct from (old.resource_type, old.resource_id, old.space_id) then
      raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
    end if;
    raised := core.level_rank(new.access) > core.level_rank(old.access)
      or exists (select 1 from jsonb_each_text(new.per_party) p
                  where p.value <> 'none' and (old.per_party ->> p.key) is distinct from p.value);
  end if;
  if raised then
    if not work.my_agent_full(new.resource_id) then
      raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
    end if;
    -- Into an external Space only its admin writes; anyone else's share waits for one.
    if exists (select 1 from work.space s where s.id = new.space_id and s.kind = 'external')
       and (work.space_role(new.space_id) is distinct from 'admin'
            or not core.has_permission('spaces.external')) then
      raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end
$$;
create trigger space_resource_agent before insert or update on work.space_resource
  for each row execute function work.guard_agent_resource();

-- A request waiting for a Space's admins keeps the party levels it asked for.
alter table work.share_request
  add column per_party jsonb not null default '{}' check (jsonb_typeof(per_party) = 'object');

-- Whether this was denied within the cooldown, whoever asked.
create function work.space_share_denied(p_space uuid, p_agent uuid, p_days integer) returns boolean
language sql stable security definer set search_path = '' as $$
  select work.agent_full_by_right(p_agent, core.current_user_id()) and exists (
    select 1 from work.share_request r
     where r.workspace_id = core.current_workspace_id() and r.resource_type = 'agent'
       and r.resource_id = p_agent and r.principal_type = 'space' and r.principal_id = p_space
       and r.status = 'denied' and r.decided_at > now() - make_interval(days => p_days))
$$;
alter function work.space_share_denied(uuid, uuid, integer) owner to legallabs_definer;
grant execute on function work.space_share_denied(uuid, uuid, integer) to legallabs_app;

-- The queue a Space admin decides. They may not be able to read the agent, so they get its title.
create function work.space_share_requests(p_space uuid)
returns table (id uuid, agent_id uuid, title text, level text, per_party jsonb,
               requested_by uuid, requester_name text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.id, r.resource_id, a.title, r.level, r.per_party, r.requested_by,
         coalesce(nullif(u.name, ''), u.email::text), r.created_at
    from work.share_request r
    join work.agent a on a.id = r.resource_id and a.deleted_at is null
    join core."user" u on u.id = r.requested_by
   where r.workspace_id = core.current_workspace_id() and r.resource_type = 'agent'
     and r.principal_type = 'space' and r.principal_id = p_space
     and r.approver = 'space_admin' and r.status = 'pending'
     and core.is_active_member() and work.space_role(p_space) = 'admin'
   order by r.created_at, r.id
$$;
alter function work.space_share_requests(uuid) owner to legallabs_definer;
grant execute on function work.space_share_requests(uuid) to legallabs_app;

-- A Space admin's decision. Accepting writes the grant, after checking that whoever asked could
-- still make it themselves.
create function work.decide_space_share(p_space uuid, p_id uuid, p_accept boolean, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  r work.share_request%rowtype;
  allowed boolean;
begin
  if not core.is_active_member() or work.space_role(p_space) is distinct from 'admin' then
    return 'FORBIDDEN';
  end if;
  select * into r from work.share_request
   where id = p_id and workspace_id = core.current_workspace_id() and status = 'pending'
     and principal_type = 'space' and principal_id = p_space and approver = 'space_admin'
     and resource_type = 'agent'
   for update;
  if not found then return 'NOT_FOUND'; end if;
  if p_accept then
    -- Still in the Space (directly, by group, or managing every Space), holding Full and the
    -- permission to share outside.
    select work.agent_full_by_right(r.resource_id, u.id)
           and (u.extra_permissions || coalesce(o.permissions, '{}')) && array['spaces.external', '*']
           and ((u.extra_permissions || coalesce(o.permissions, '{}')) && array['spaces.manage', '*']
                or exists (
                  select 1 from work.space_member m
                   where m.space_id = p_space and m.role <> 'guest'
                     and ((m.principal_type = 'user' and m.principal_id = u.id)
                       or (m.principal_type = 'group' and exists (
                             select 1 from core.group_member g
                              where g.group_id = m.principal_id and g.user_id = u.id)))))
      into allowed
      from core."user" u
      left join core.role o on o.workspace_id = u.workspace_id and o.id = u.role_id
     where u.id = r.requested_by and u.workspace_id = r.workspace_id;
    if not coalesce(allowed, false) then return 'STALE'; end if;
    insert into work.space_resource
      (workspace_id, space_id, resource_type, resource_id, access, per_party, granted_by)
    values (r.workspace_id, p_space, 'agent', r.resource_id, r.level, r.per_party, r.requested_by)
    on conflict (space_id, resource_type, resource_id)
      do update set access = excluded.access, per_party = excluded.per_party;
  end if;
  update work.share_request
     set status = case when p_accept then 'accepted' else 'denied' end,
         decided_by = core.current_user_id(), decided_at = now(), reason = left(p_reason, 500)
   where id = p_id;
  return 'OK';
end
$$;
alter function work.decide_space_share(uuid, uuid, boolean, text) owner to legallabs_definer;
revoke execute on function work.decide_space_share(uuid, uuid, boolean, text) from public;
grant execute on function work.decide_space_share(uuid, uuid, boolean, text) to legallabs_app;
grant insert, update on work.space_resource to legallabs_definer;
create policy definer_share_insert on work.space_resource for insert to legallabs_definer
  with check (workspace_id = core.current_workspace_id());
create policy definer_share_update on work.space_resource for update to legallabs_definer
  using (workspace_id = core.current_workspace_id())
  with check (workspace_id = core.current_workspace_id());
