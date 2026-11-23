-- Daily audit anchors (06-security 9.1) have a recorder (admin.record_audit_anchor) and a writer
-- to write-once storage (publishAuditAnchor), but nothing ran them, so a deployment's chain had
-- nothing outside the database to be checked against. The anchor job works one workspace at a time
-- under that workspace's identity; it only needs to know which workspaces exist, which the worker
-- role may not read directly. This is the one definer function that lists them, for the worker
-- alone. Found by the security review (SEC-041).
create function admin.anchor_workspaces() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select w.id from core.workspace w order by w.id
$$;
alter function admin.anchor_workspaces() owner to legallabs_definer;
revoke execute on function admin.anchor_workspaces() from public;
grant execute on function admin.anchor_workspaces() to legallabs_worker;
