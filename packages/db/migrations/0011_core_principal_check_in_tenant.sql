-- Check the workspace first, so the error never reveals who exists in another one.
create or replace function core.check_principal() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if core.current_workspace_id() is not null
     and new.workspace_id is distinct from core.current_workspace_id() then
    raise exception 'principal % % is not in this workspace', new.principal_type, new.principal_id
      using errcode = 'foreign_key_violation';
  end if;
  if (new.principal_type = 'user' and exists (
        select 1 from core."user" u where u.id = new.principal_id and u.workspace_id = new.workspace_id))
     or (new.principal_type = 'group' and exists (
        select 1 from core."group" g where g.id = new.principal_id and g.workspace_id = new.workspace_id))
     or (new.principal_type = 'workspace' and new.principal_id = new.workspace_id)
  then
    return new;
  end if;
  raise exception 'principal % % is not in this workspace', new.principal_type, new.principal_id
    using errcode = 'foreign_key_violation';
end
$$;
