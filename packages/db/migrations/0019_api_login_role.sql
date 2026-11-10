-- Created without login: the operator turns that on and chooses the password.
-- No inherited rights, so a connection that skips SET ROLE can read nothing.
do $$
begin
  if not exists (select from pg_roles where rolname = 'legallabs_api') then
    create role legallabs_api nologin noinherit;
  end if;
end
$$;
grant legallabs_app to legallabs_api;
