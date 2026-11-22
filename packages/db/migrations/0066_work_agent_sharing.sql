-- Sharing an agent, and who sees its runs (agents-workflows.md §4.5, §4.6). Only someone with
-- Full access shares; the module checks, and these functions check again.

create function work.agent_shares(p_agent uuid)
returns table (id uuid, principal_type text, principal_id uuid, level text, granted_by uuid,
               granted_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select g.id, g.principal_type, g.principal_id, g.level, g.granted_by, g.granted_at
    from core.share_grant g
   where g.object_type = 'agent' and g.object_id = p_agent
     and g.workspace_id = core.current_workspace_id()
     and work.agent_level(p_agent) = 'full'
   order by g.granted_at
$$;

create function work.agent_share(p_agent uuid, p_type text, p_principal uuid, p_level text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  grant_id uuid;
begin
  if work.agent_level(p_agent) is distinct from 'full' then
    raise exception 'sharing needs full access' using errcode = '42501';
  end if;
  insert into core.share_grant (workspace_id, object_type, object_id, principal_type,
                                principal_id, level, granted_by)
  values (core.current_workspace_id(), 'agent', p_agent, p_type, p_principal, p_level,
          core.current_user_id())
  on conflict (object_type, object_id, principal_type, principal_id)
    do update set level = excluded.level, granted_by = excluded.granted_by, granted_at = now()
  returning id into grant_id;
  return grant_id;
end
$$;

create function work.agent_unshare(p_agent uuid, p_grant uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if work.agent_level(p_agent) is distinct from 'full' then
    raise exception 'sharing needs full access' using errcode = '42501';
  end if;
  delete from core.share_grant
   where id = p_grant and object_type = 'agent' and object_id = p_agent
     and workspace_id = core.current_workspace_id();
  return found;
end
$$;

-- Deleting is a function because a policy check can't see the row's old level once it is
-- marked deleted. Only Full access may; the agent's schedules are paused by trigger.
create function work.agent_delete(p_agent uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if work.agent_level(p_agent) is distinct from 'full' then
    raise exception 'deleting needs full access' using errcode = '42501';
  end if;
  update work.agent set deleted_at = now(), deleted_by = core.current_user_id()
   where id = p_agent and deleted_at is null;
  return found;
end
$$;
alter function work.agent_delete(uuid) owner to legallabs_definer;
revoke execute on function work.agent_delete(uuid) from public;
grant execute on function work.agent_delete(uuid) to legallabs_app;
grant update (deleted_at, deleted_by) on work.agent to legallabs_definer;
create policy definer_update on work.agent for update to legallabs_definer
  using (true) with check (true);

-- The best shared agent for what someone typed. It reads the title and description text of
-- versions, which Run access may not read as a whole, so it runs as the definer.
create function work.agent_nudge(p_prompt text, p_quiet_days integer)
returns table (id uuid, title text, rank double precision)
language sql stable security definer set search_path = '' as $$
  with q as (
    select nullif(array_to_string(tsvector_to_array(to_tsvector('english', p_prompt)), ' | '), '')
           as terms
  )
  select a.id, a.title, ts_rank_cd(v.tsv, to_tsquery('english', q.terms))::float8 as rank
    from q
    join work.agent a on a.deleted_at is null
                     and a.workspace_id = core.current_workspace_id()
                     and a.owner_id <> core.current_user_id()
    join work.agent_version v on v.id = a.live_version_id
   where q.terms is not null
     and work.agent_level(a.id) is not null
     and coalesce((select c.nudges_enabled from work.sharing_config c
                    where c.workspace_id = a.workspace_id), true)
     and not exists (select 1 from work.agent_nudge_dismissal d
                      where d.agent_id = a.id and d.user_id = core.current_user_id()
                        and d.dismissed_at > now() - make_interval(days => p_quiet_days))
     and v.tsv @@ to_tsquery('english', q.terms)
   order by rank desc, a.id
   limit 1
$$;
alter function work.agent_nudge(text, integer) owner to legallabs_definer;
revoke execute on function work.agent_nudge(text, integer) from public;
grant execute on function work.agent_nudge(text, integer) to legallabs_app;
grant select on work.sharing_config, work.agent_nudge_dismissal to legallabs_definer;
create policy definer_read on work.sharing_config for select to legallabs_definer using (true);
create policy definer_read on work.agent_nudge_dismissal for select to legallabs_definer using (true);

-- A schedule whose owner lost access can't be changed by that owner's own policy, so the
-- worker pauses it through this.
create function work.agent_schedule_pause(p_id uuid, p_reason text) returns void
language sql security definer set search_path = '' as $$
  update work.agent_schedule
     set status = 'paused', paused_reason = left(p_reason, 200), updated_at = now()
   where id = p_id
$$;
alter function work.agent_schedule_pause(uuid, text) owner to legallabs_definer;
revoke execute on function work.agent_schedule_pause(uuid, text) from public;
grant execute on function work.agent_schedule_pause(uuid, text) to legallabs_worker;

-- Whether a person could be given Edit or Full: it needs agents.build as well.
create function work.user_can_build(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select ('agents.build' = any (u.extra_permissions || r.permissions)
            or '*' = any (r.permissions)) and u.kind = 'member' and u.status = 'active'
      from core."user" u
      left join core.role r on r.workspace_id = u.workspace_id and r.id = u.role_id
     where u.id = p_user and u.workspace_id = core.current_workspace_id()), false)
$$;

-- Schedules on an agent, for pausing their Temporal schedules when it is deleted.
create function work.agent_schedule_ids(p_agent uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select s.id from work.agent_schedule s
   where s.agent_id = p_agent and s.workspace_id = core.current_workspace_id()
     and work.agent_level(p_agent) = 'full'
$$;

alter function work.agent_shares(uuid) owner to legallabs_definer;
alter function work.agent_share(uuid, text, uuid, text) owner to legallabs_definer;
alter function work.agent_unshare(uuid, uuid) owner to legallabs_definer;
alter function work.user_can_build(uuid) owner to legallabs_definer;
alter function work.agent_schedule_ids(uuid) owner to legallabs_definer;
revoke execute on function work.agent_shares(uuid), work.agent_share(uuid, text, uuid, text),
  work.agent_unshare(uuid, uuid), work.user_can_build(uuid), work.agent_schedule_ids(uuid)
  from public;
grant execute on function work.agent_shares(uuid), work.agent_share(uuid, text, uuid, text),
  work.agent_unshare(uuid, uuid), work.user_can_build(uuid), work.agent_schedule_ids(uuid)
  to legallabs_app;
grant select, insert, update, delete on core.share_grant to legallabs_definer;
grant select on core."user", core.role to legallabs_definer;

-- Runs of an agent are seen by the runner and by Full-access holders, with their steps; the
-- step's prompt text stays with the runner because it lives in object storage, not here.
create policy run_read_agent_full on work.run for select to legallabs_app
  using (core.in_tenant(workspace_id) and kind = 'agent' and work.agent_level(subject_id) = 'full');
create policy run_step_read_agent_full on work.run_step for select to legallabs_app
  using (core.in_tenant(workspace_id) and exists (
    select 1 from work.run r
     where r.id = run_id and r.kind = 'agent' and work.agent_level(r.subject_id) = 'full'));
create policy run_event_read_agent_full on work.run_event for select to legallabs_app
  using (core.in_tenant(workspace_id) and exists (
    select 1 from work.run r
     where r.id = run_id and r.kind = 'agent' and work.agent_level(r.subject_id) = 'full'));
