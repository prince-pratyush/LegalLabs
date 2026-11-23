-- A synced vault runs on the OAuth tokens of the connection it names. The API only lets a person
-- link a vault to a connection of their own, but the database let any vault owner name any
-- connection in the workspace (the policy checks the vault, the foreign key only the workspace).
-- With a connection id in hand, that would import files from someone else's Drive into the
-- owner's vault. The check now lives where the data is: a connection can be named only by its own
-- person, and cannot be changed afterwards. Found by the security review (pen-test P-02).
create function content.guard_sync_connection() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Migrations and maintenance run as the owner; only app requests are limited.
  if current_user <> 'legallabs_app' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.connection_id is distinct from old.connection_id then
      raise exception 'a synced vault keeps its connection' using errcode = '42501';
    end if;
    return new;
  end if;
  -- Policies on the connection table show a person only their own.
  if not exists (select 1 from content.sync_connection c
                  where c.id = new.connection_id and c.user_id = core.current_user_id()) then
    raise exception 'that connection is not yours' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger vault_sync_connection_guard
  before insert or update of connection_id on content.vault_sync
  for each row execute function content.guard_sync_connection();
