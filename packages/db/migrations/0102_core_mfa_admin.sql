-- What a person has enrolled, for themselves or for an admin who manages users.
create function core.mfa_summary(p_user uuid)
returns table (has_totp boolean, passkeys integer, recovery_remaining integer)
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core.mfa_totp t
                  where t.workspace_id = core.current_workspace_id() and t.user_id = p_user
                    and t.confirmed_at is not null),
         (select count(*)::integer from core.mfa_passkey k
           where k.workspace_id = core.current_workspace_id() and k.user_id = p_user),
         (select count(*)::integer from core.mfa_recovery_code c
           where c.workspace_id = core.current_workspace_id() and c.user_id = p_user
             and c.used_at is null)
   where core.is_active_member()
     and (p_user = core.current_user_id() or core.has_permission('admin.users'))
     and exists (select 1 from core."user" u
                  where u.workspace_id = core.current_workspace_id() and u.id = p_user)
$$;

-- For a person locked out of their factors. The admin must hold admin.users, and the target must
-- be in the admin's own workspace; returns how many factor rows were removed.
create function core.mfa_reset_user(p_target uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  removed integer := 0;
  n integer;
begin
  if not core.has_permission('admin.users') then
    raise exception 'admin.users is required' using errcode = '42501';
  end if;
  if not exists (select 1 from core."user" u where u.workspace_id = ws and u.id = p_target) then
    raise exception 'no such user' using errcode = '42501';
  end if;
  delete from core.mfa_totp where workspace_id = ws and user_id = p_target;
  get diagnostics n = row_count; removed := removed + n;
  delete from core.mfa_passkey where workspace_id = ws and user_id = p_target;
  get diagnostics n = row_count; removed := removed + n;
  delete from core.mfa_recovery_code where workspace_id = ws and user_id = p_target;
  delete from core.mfa_pending where workspace_id = ws and user_id = p_target;
  return removed;
end
$$;

-- Step-up stamps the caller's own live session after a factor passed. Direct writes to mfa_at
-- stay revoked from the app (0007), so only this function can move it.
grant update (mfa_at) on core.session to legallabs_definer;
create policy definer_step_up on core.session for update to legallabs_definer
  using (true) with check (true);

create function core.mfa_session_touch(p_session uuid) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  stamped timestamptz;
begin
  update core.session s
     set mfa_at = now()
   where s.id = p_session
     and s.workspace_id = core.current_workspace_id()
     and s.user_id = core.current_user_id()
     and s.revoked_at is null
     and s.expires_at > now()
     and core.is_active_member()
  returning s.mfa_at into stamped;
  return stamped;
end
$$;
alter function core.mfa_session_touch(uuid) owner to legallabs_definer;
grant execute on function core.mfa_session_touch(uuid) to legallabs_app;

alter function core.mfa_summary(uuid) owner to legallabs_definer;
alter function core.mfa_reset_user(uuid) owner to legallabs_definer;
grant execute on function core.mfa_summary(uuid), core.mfa_reset_user(uuid) to legallabs_app;
