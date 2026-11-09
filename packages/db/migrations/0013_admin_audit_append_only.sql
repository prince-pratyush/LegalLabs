create function admin.reject_audit_change() returns trigger
language plpgsql as $$
begin
  raise exception 'audit records cannot be changed' using errcode = '42501';
end
$$;
grant execute on function admin.reject_audit_change() to legallabs_definer;

-- Row triggers on the parent are cloned to every partition; truncate triggers are not.
create trigger audit_event_immutable before update or delete on admin.audit_event
  for each row execute function admin.reject_audit_change();
create trigger audit_event_no_truncate before truncate on admin.audit_event
  for each statement execute function admin.reject_audit_change();

revoke update, delete, truncate on admin.audit_event from legallabs_definer;

create or replace function admin.protect_audit_partition(partition_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  execute format('alter table admin.%I enable row level security', partition_name);
  execute format('alter table admin.%I force row level security', partition_name);
  execute format('create policy no_direct_access on admin.%I for select to legallabs_app using (false)',
                 partition_name);
  execute format('create trigger audit_event_no_truncate before truncate on admin.%I
                  for each statement execute function admin.reject_audit_change()', partition_name);
  execute format('revoke update, delete, truncate on admin.%I from legallabs_definer', partition_name);
end
$$;

create trigger audit_event_no_truncate before truncate on admin.audit_event_default
  for each statement execute function admin.reject_audit_change();
revoke update, delete, truncate on admin.audit_event_default from legallabs_definer;
