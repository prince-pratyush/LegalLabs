-- Findings F-40 and F-41 of the third security review.

-- F-41 (agents-workflows.md §4.6, spaces-matters.md §7): only Space grants of an agent were held
-- to the walls of the matters its files belong to. A direct, group or workspace grant now gives
-- a walled person nothing, for as long as they are walled.
create function work.agent_walled(p_agent uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core.matter m
     where m.workspace_id = core.current_workspace_id() and m.require_walls_for_sharing
       and m.id in (select work.agent_matters(p_agent))
       and not core.can_access_matter(m.id))
$$;
alter function work.agent_walled(uuid) owner to legallabs_definer;
revoke execute on function work.agent_walled(uuid) from public;
grant execute on function work.agent_walled(uuid) to legallabs_app, legallabs_definer;

-- How many people a proposed grant would reach who are walled; zero to anyone without Full.
create function work.agent_grant_blocked(p_agent uuid, p_type text, p_principal uuid)
returns integer
language sql stable security definer set search_path = '' as $$
  select count(distinct person)::integer
    from core.grant_recipients(p_type, p_principal) person
    join core.matter m on m.workspace_id = core.current_workspace_id()
     and m.require_walls_for_sharing and m.id in (select work.agent_matters(p_agent))
   where work.agent_level(p_agent) = 'full'
     and not core.user_can_access_matter(person, m.id)
$$;
alter function work.agent_grant_blocked(uuid, text, uuid) owner to legallabs_definer;
revoke execute on function work.agent_grant_blocked(uuid, text, uuid) from public;
grant execute on function work.agent_grant_blocked(uuid, text, uuid) to legallabs_app;

-- As 0200, with the agent wall on the direct branch too.
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
             and me.kind = 'member'))
       and (g.object_type <> 'agent' or not work.agent_walled(g.object_id)))
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

-- F-40: someone with only Run on an agent could link its upload into an agent of their own, and
-- so keep reading it after the share ended, and hand it on. Refused unless they own the file or
-- hold View on an agent that carries it.
create function work.agent_upload_linkable(p_document uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from content.document d
                  where d.id = p_document and d.workspace_id = core.current_workspace_id()
                    and d.owner_id = core.current_user_id())
      or not exists (select 1 from work.agent_document x
                      where x.document_id = p_document
                        and x.workspace_id = core.current_workspace_id()
                        and work.agent_level(x.agent_id) = 'run')
      or exists (select 1 from work.agent_document x
                  where x.document_id = p_document
                    and x.workspace_id = core.current_workspace_id()
                    and work.agent_level(x.agent_id) in ('view', 'edit', 'full'))
$$;
alter function work.agent_upload_linkable(uuid) owner to legallabs_definer;
revoke execute on function work.agent_upload_linkable(uuid) from public;
grant execute on function work.agent_upload_linkable(uuid) to legallabs_app;

drop policy agent_document_write on work.agent_document;
create policy agent_document_write on work.agent_document for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and work.agent_level(agent_id) in ('edit', 'full')
              and work.agent_upload_linkable(document_id));
