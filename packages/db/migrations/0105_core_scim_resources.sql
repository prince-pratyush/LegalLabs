-- SCIM provisioning: the columns an identity provider needs and the narrow rights the SCIM
-- service principal holds. The principal is a 'service' user behind an api_token with scope
-- 'scim'; it provisions people but never decides what they may do.
create schema scim;
grant usage on schema scim to legallabs_app, legallabs_definer;

alter table core."user"
  add column scim_external_id text,
  add column scim_managed boolean not null default false,
  -- A SCIM DELETE hides the person from SCIM; the row stays so history keeps who did what.
  add column scim_deleted_at timestamptz,
  add column role_from_group boolean not null default false,
  add column updated_at timestamptz not null default now(),
  add column scim_version integer not null default 1;
create index user_scim_external_idx on core."user" (workspace_id, scim_external_id)
  where scim_external_id is not null;

alter table core."group"
  add column updated_at timestamptz not null default now(),
  add column scim_version integer not null default 1;

-- Backs ETag and meta.lastModified: every write moves both.
create function core.touch_scim_meta() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.scim_version := old.scim_version + 1;
  return new;
end
$$;
create trigger user_touch_scim before update on core."user"
  for each row execute function core.touch_scim_meta();
create trigger group_touch_scim before update on core."group"
  for each row execute function core.touch_scim_meta();

-- True for an active service user whose token carries the scim scope, in a workspace where an
-- admin has switched SCIM on. Every SCIM policy below starts from this.
create function scim.is_principal() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from core."user" u
      join core.workspace w on w.id = u.workspace_id
     where u.id = core.current_user_id()
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active'
       and u.kind = 'service'
       and coalesce(w.settings ->> 'scim_enabled', 'false') = 'true'
       and exists (
         select 1 from core.api_token t
          where t.workspace_id = u.workspace_id and t.principal_id = u.id
            and t.revoked_at is null and t.expires_at > now() and 'scim' = any (t.scopes)))
$$;
alter function scim.is_principal() owner to legallabs_definer;
grant execute on function scim.is_principal() to legallabs_app, legallabs_definer;

-- The provider may add people and change their profile, never their access.
create or replace function core.guard_user() returns trigger
language plpgsql as $$
begin
  -- Migrations and maintenance run as the owner; only app requests are limited.
  if current_user <> 'legallabs_app' then
    return new;
  end if;
  if scim.is_principal() then
    if tg_op = 'INSERT' then
      if new.kind <> 'member' or new.role_id is not null or new.extra_permissions <> '{}' then
        raise exception 'SCIM cannot set access' using errcode = 'insufficient_privilege';
      end if;
    elsif (new.kind, new.role_id, new.extra_permissions, new.role_from_group)
          is distinct from (old.kind, old.role_id, old.extra_permissions, old.role_from_group) then
      raise exception 'SCIM cannot set access' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.kind is distinct from old.kind then
      raise exception 'kind cannot change' using errcode = 'check_violation';
    end if;
    if new.id = core.current_user_id()
       and (new.role_id, new.extra_permissions, new.status)
           is distinct from (old.role_id, old.extra_permissions, old.status) then
      raise exception 'nobody can change their own access' using errcode = 'insufficient_privilege';
    end if;
    if (new.role_id, new.extra_permissions) is not distinct from (old.role_id, old.extra_permissions) then
      return new;
    end if;
  end if;
  if not core.holds_all(core.role_permissions(new.role_id) || new.extra_permissions) then
    raise exception 'cannot grant permissions you do not hold' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;

-- Policies add to the existing ones. Members only: guests and service users are not SCIM's.
create policy scim_user_insert on core."user" for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and scim.is_principal() and kind = 'member');
create policy scim_user_update on core."user" for update to legallabs_app
  using (core.in_tenant(workspace_id) and scim.is_principal() and kind = 'member')
  with check (core.in_tenant(workspace_id) and kind = 'member');

create policy scim_group_read on core."group" for select to legallabs_app
  using (core.in_tenant(workspace_id) and scim.is_principal());
create policy scim_group_write on core."group" for all to legallabs_app
  using (core.in_tenant(workspace_id) and scim.is_principal())
  with check (core.in_tenant(workspace_id) and scim.is_principal());
create policy scim_member_read on core.group_member for select to legallabs_app
  using (core.in_tenant(workspace_id) and scim.is_principal());
create policy scim_member_write on core.group_member for all to legallabs_app
  using (core.in_tenant(workspace_id) and scim.is_principal())
  with check (core.in_tenant(workspace_id) and scim.is_principal());

-- Deprovisioning cuts every way back in at once. A function rather than a policy, so the
-- provider never gets to read session or token rows.
grant update (revoked_at) on core.session, core.api_token to legallabs_definer;
create policy definer_revoke on core.session for update to legallabs_definer
  using (true) with check (true);
create policy definer_revoke on core.api_token for update to legallabs_definer
  using (true) with check (true);

create function scim.revoke_user_access(p_user uuid) returns table (sessions int, tokens int)
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  s int;
  t int;
begin
  if not scim.is_principal() then
    raise exception 'not the SCIM principal' using errcode = '42501';
  end if;
  if not exists (select 1 from core."user" u
                  where u.id = p_user and u.workspace_id = ws and u.kind = 'member') then
    raise exception 'unknown person' using errcode = '42501';
  end if;
  update core.session set revoked_at = now()
   where workspace_id = ws and user_id = p_user and revoked_at is null;
  get diagnostics s = row_count;
  update core.api_token set revoked_at = now()
   where workspace_id = ws and principal_id = p_user and revoked_at is null;
  get diagnostics t = row_count;
  return query select s, t;
end
$$;
alter function scim.revoke_user_access(uuid) owner to legallabs_definer;
grant execute on function scim.revoke_user_access(uuid) to legallabs_app;
