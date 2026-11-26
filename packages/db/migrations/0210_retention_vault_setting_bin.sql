-- SEC-029 (06-security 5.5), finding F-37: a vault's own retention setting deleted files for
-- good. The policy sweep already reads that setting as the vault's policy (0121, 0205), so it
-- now carries it out alone: recycle bin, 30 days, legal holds, restore restarts the clock.
drop function content.sweep_vault_retention();

-- A synced vault is read-only to people (P-02). The older job got past that guard with its own
-- delete reason; the sweep and the recycle bin restore did not, so retention could not bin a
-- mirrored file at all. Both now run as a writer, for the length of the call only.
alter function retention.sweep_all() rename to _sweep_all;
alter function retention.restore(uuid) rename to _restore;
revoke execute on function retention._sweep_all() from legallabs_worker;
revoke execute on function retention._restore(uuid) from legallabs_app;

create function retention.sweep_all() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  was text := coalesce(current_setting('legallabs.sync_writer', true), '');
  result jsonb;
begin
  perform set_config('legallabs.sync_writer', 'on', true);
  result := retention._sweep_all();
  perform set_config('legallabs.sync_writer', was, true);
  return result;
end
$$;

-- _restore checks that the caller is a retention admin; an error rolls the setting back too.
create function retention.restore(p_bin uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  was text := coalesce(current_setting('legallabs.sync_writer', true), '');
  result jsonb;
begin
  perform set_config('legallabs.sync_writer', 'on', true);
  result := retention._restore(p_bin);
  perform set_config('legallabs.sync_writer', was, true);
  return result;
end
$$;

alter function retention.sweep_all() owner to legallabs_definer;
alter function retention.restore(uuid) owner to legallabs_definer;
revoke execute on function retention.sweep_all(), retention.restore(uuid) from public;
grant execute on function retention.sweep_all() to legallabs_worker;
grant execute on function retention.restore(uuid) to legallabs_app;
