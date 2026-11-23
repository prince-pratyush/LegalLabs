-- An agent run records the Space and matter it works in, and other code trusts those columns: a
-- Space's admins may control its runs, a matter's model rules decide which models it may use. The
-- insert policy checked the owner and the thread but not these two, so a person could start a run
-- that named a Space they cannot see (or another workspace's) or a matter they are walled from.
-- The run now has to claim only what its owner can already open. Found by the security review
-- (pen-test P-04).
drop policy run_insert_agent on work.run;
create policy run_insert_agent on work.run for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and kind in ('agent', 'workflow', 'agent_builder')
              and owner_id = core.current_user_id()
              and core.has_permission('agents.use')
              and exists (select 1 from work.thread t
                           where t.id = thread_id and t.owner_id = core.current_user_id())
              -- Spaces are visible to their members only, and only within the workspace.
              and (space_id is null or exists (select 1 from work.space s where s.id = space_id))
              and core.can_access_matter(matter_id));
