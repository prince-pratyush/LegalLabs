-- A Space task given to the assistant is a run of its own kind. Its subject is the task. The
-- thread policies already cover it (threads.use, the owner's own thread); like agent runs it may
-- only claim a Space and a matter its owner can open.
alter table work.run
  drop constraint run_kind_check,
  add constraint run_kind_check check (kind in ('thread', 'deep_analysis', 'playbook_review',
    'rt_column', 'agent', 'workflow', 'agent_builder', 'assistant')),
  drop constraint run_agent_subject,
  add constraint run_agent_subject check (
    (kind in ('agent', 'workflow', 'agent_builder', 'assistant')) = (subject_id is not null));

create policy run_assistant_scope on work.run as restrictive for insert to legallabs_app
  with check (kind <> 'assistant'
              or ((space_id is null or exists (select 1 from work.space s where s.id = space_id))
                  and core.can_access_matter(matter_id)));

-- A task's run belongs to the member who started it, while the task belongs to its Space. The
-- API asks who that was, only after checking the caller can see the task.
grant select (id, workspace_id, owner_id, path, task_id) on work.run to legallabs_definer;
create function work.task_run_owner(p_workspace uuid, p_run uuid)
returns table (owner_id uuid, task_id uuid)
language sql stable security definer set search_path = '' as $$
  select r.owner_id, r.task_id from work.run r
   where r.workspace_id = p_workspace and r.id = p_run
     and r.path = 'task' and r.task_id is not null
$$;
alter function work.task_run_owner(uuid, uuid) owner to legallabs_definer;
revoke execute on function work.task_run_owner(uuid, uuid) from public;
grant execute on function work.task_run_owner(uuid, uuid) to legallabs_worker;
grant usage on schema work to legallabs_worker;
