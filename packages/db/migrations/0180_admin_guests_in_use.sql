-- A guest can only sign in with an emailed code, so a production server without a mail server
-- must refuse to start once guests exist. It asks before any identity is set, and the worker role
-- may not read these tables (nor use the core schema): this says yes or no, nothing about who or which workspace.
create function admin.guests_in_use() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core.guest_profile p
      join core."user" u on u.workspace_id = p.workspace_id and u.id = p.user_id
     where u.status = 'active' and p.deactivated_at is null and p.expires_at > now())
  or exists (
    select 1 from work.guest_invite i
     where i.accepted_at is null and i.revoked_at is null and i.expires_at > now())
$$;
alter function admin.guests_in_use() owner to legallabs_definer;
revoke execute on function admin.guests_in_use() from public;
grant execute on function admin.guests_in_use() to legallabs_worker;
