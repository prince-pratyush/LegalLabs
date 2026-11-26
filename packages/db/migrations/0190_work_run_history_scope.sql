-- Full access on an agent shows other people's runs of it: summaries, not their content
-- (agents-workflows.md §4.5). Two things went further. The read policy never asked about the
-- run's matter, so someone walled from it saw the run; and the event log followed run
-- visibility, so it handed over the answer, the quotes from the runner's documents and the
-- arguments of tool calls. Found by the security review (F-23).
drop policy run_read_agent_full on work.run;
create policy run_read_agent_full on work.run for select to legallabs_app
  using (core.in_tenant(workspace_id) and kind = 'agent' and work.agent_level(subject_id) = 'full'
         and core.can_access_matter(matter_id));

-- An agent run's content events are for whoever can see its thread: the runner, and anyone the
-- runner shared it with. Everyone else who sees the run gets its progress. The step and event
-- read policies look the run up under its own policies, so the wall above covers both.
drop policy run_event_read_agent_full on work.run_event;
drop policy run_event_read on work.run_event;
create policy run_event_read on work.run_event for select to legallabs_app
  using (core.in_tenant(workspace_id) and exists (
    select 1 from work.run r
     where r.id = run_id
       and (r.kind <> 'agent'
            or run_event.type in ('status', 'step', 'done')
            or exists (select 1 from work.thread t where t.id = r.thread_id))));
