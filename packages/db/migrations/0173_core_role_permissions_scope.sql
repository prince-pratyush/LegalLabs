-- core.role_permissions(role_id) is a definer function, so it read any workspace's role: anyone
-- who could call it (every signed-in request, and a request with no identity at all) learned the
-- permission set of any role id they could name. Role ids are not guessable, so this was an
-- information leak rather than a hole, but a definer function must not answer across tenants.
-- Every caller is a guard trigger or function that already runs inside a request, where the
-- workspace is set. Found by the security review's cross-tenant function fuzz (pen-test P-01).
create or replace function core.role_permissions(role_id uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce((select r.permissions from core.role r
                    where r.id = role_permissions.role_id
                      and r.workspace_id = core.current_workspace_id()), '{}')
$$;
