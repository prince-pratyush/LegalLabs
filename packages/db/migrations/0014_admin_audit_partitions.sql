-- Safe to run as often as a job likes.
create function admin.ensure_audit_partitions() returns void
language plpgsql security definer set search_path = '' as $$
declare
  first_day timestamp;
  partition_name text;
begin
  for i in 0..3 loop
    first_day := date_trunc('month', now() at time zone 'UTC') + make_interval(months => i);
    partition_name := 'audit_event_y' || to_char(first_day, 'YYYY"m"MM');
    continue when to_regclass('admin.' || partition_name) is not null;
    begin
      execute format('create table admin.%I partition of admin.audit_event for values from (%L) to (%L)',
                     partition_name,
                     first_day at time zone 'UTC',
                     (first_day + interval '1 month') at time zone 'UTC');
      perform admin.protect_audit_partition(partition_name);
    exception when check_violation then
      -- That month already has rows in the catch-all; one bad month must not block the rest.
      raise warning 'audit partition % skipped: rows exist in the default partition', partition_name;
    end;
  end loop;
end
$$;
alter function admin.ensure_audit_partitions() owner to legallabs_definer;
grant execute on function admin.ensure_audit_partitions() to legallabs_app;

select admin.ensure_audit_partitions();
