-- Cancelling reaches a run between steps through the engine. A model or tool call already in
-- flight can take minutes and still costs or acts, so the step watches this mark and drops it.
-- It lives in the row, not in a process, so a Temporal worker sees it too.
alter table work.run add column cancel_requested_at timestamptz;
grant update (cancel_requested_at) on work.run to legallabs_app;
