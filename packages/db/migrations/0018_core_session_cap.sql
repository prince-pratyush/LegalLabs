-- SECURITY DEFINER because the person's kind must be read whoever is inserting.
create function core.cap_session_life() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  cap interval;
begin
  select case u.kind when 'member' then interval '7 days' when 'guest' then interval '24 hours' end
    into cap
    from core."user" u
   where u.workspace_id = new.workspace_id and u.id = new.user_id;
  if cap is null or new.expires_at > now() + cap then
    raise exception 'session exceeds its lifetime cap' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function core.cap_session_life() owner to legallabs_definer;

create trigger session_cap_life before insert on core.session
  for each row execute function core.cap_session_life();
