-- Guests get a fixed set through their Space; service accounts act through token scopes.
alter table core."user" add constraint user_member_access
  check (kind = 'member' or (role_id is null and extra_permissions = '{}'));

create function core.role_permissions(role_id uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce((select r.permissions from core.role r where r.id = role_permissions.role_id), '{}')
$$;

-- People may hand out only permissions they hold themselves.
create function core.holds_all(permissions text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select '*' = any (coalesce(r.permissions, '{}'))
           or holds_all.permissions <@ (u.extra_permissions || coalesce(r.permissions, '{}'))
      from core."user" u
      left join core.role r on r.workspace_id = u.workspace_id and r.id = u.role_id
     where u.id = core.current_user_id()
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active'
       and u.kind = 'member'), false)
$$;

alter function core.role_permissions(uuid) owner to legallabs_definer;
alter function core.holds_all(text[]) owner to legallabs_definer;
grant execute on function core.role_permissions(uuid), core.holds_all(text[]) to legallabs_app;

create function core.guard_user() returns trigger
language plpgsql as $$
begin
  -- Migrations and maintenance run as the owner; only app requests are limited.
  if current_user <> 'legallabs_app' then
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

create function core.guard_role() returns trigger
language plpgsql as $$
begin
  if current_user = 'legallabs_app' and not core.holds_all(new.permissions) then
    raise exception 'cannot grant permissions you do not hold' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;

create trigger user_guard before insert or update on core."user"
  for each row execute function core.guard_user();
create trigger role_guard before insert or update on core.role
  for each row execute function core.guard_role();
