-- Roles are cluster-wide, so they may already exist.
do $$
begin
  if not exists (select from pg_roles where rolname = 'legallabs_app') then
    create role legallabs_app nologin;
  end if;
  -- Owns SECURITY DEFINER functions; reads only through policies written for it.
  if not exists (select from pg_roles where rolname = 'legallabs_definer') then
    create role legallabs_definer nologin;
  end if;
end
$$;

create schema core;
revoke all on schema core from public;
grant usage on schema core to legallabs_app, legallabs_definer;

-- Postgres lets everyone run new functions unless told otherwise.
alter default privileges in schema core revoke execute on functions from public;

-- Postgres 17 has no built-in UUIDv7: stamp the first 48 bits with the time in ms.
create function core.uuid7() returns uuid
language sql volatile parallel safe as $$
  select pg_catalog.encode(
    pg_catalog.set_bit(pg_catalog.set_bit(
      overlay(pg_catalog.uuid_send(pg_catalog.gen_random_uuid())
        placing substring(
          pg_catalog.int8send((extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint)
          from 3)
        from 1 for 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;

-- Unset or empty settings read as null, and every policy treats null as no access.
create function core.current_user_id() returns uuid
language sql stable as $$
  select nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid
$$;

create function core.current_workspace_id() returns uuid
language sql stable as $$
  select nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
$$;

grant execute on function core.uuid7(), core.current_user_id(), core.current_workspace_id()
  to legallabs_app, legallabs_definer;
