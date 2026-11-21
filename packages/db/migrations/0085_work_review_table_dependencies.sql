-- A column's prompt may refer to other columns of the same table with @{column_id}. The API
-- keeps `depends_on` in step with the prompt; the trigger keeps it a graph without cycles
-- even if some other path writes it.
alter table work.rt_column
  add column depends_on uuid[] not null default '{}'
    check (cardinality(depends_on) <= 20);

grant update (depends_on) on work.rt_column to legallabs_app;

create function work.rt_column_dependencies() returns trigger
language plpgsql set search_path = '' as $$
begin
  if cardinality(new.depends_on) = 0 then
    return new;
  end if;
  if new.id = any (new.depends_on) then
    raise exception 'COLUMN_CYCLE' using errcode = 'check_violation';
  end if;
  -- Every reference is a live column of this same table.
  if exists (
    select 1 from unnest(new.depends_on) d(id)
     where not exists (
       select 1 from work.rt_column k
        where k.id = d.id and k.table_id = new.table_id and k.deleted_at is null)
  ) then
    raise exception 'COLUMN_REFERENCE_UNKNOWN' using errcode = 'check_violation';
  end if;
  -- Following the references from here must never come back to this column.
  if exists (
    with recursive walk(id) as (
      select unnest(new.depends_on)
      union
      select unnest(k.depends_on)
        from work.rt_column k join walk w on k.id = w.id
       where k.deleted_at is null
    )
    select 1 from walk where id = new.id
  ) then
    raise exception 'COLUMN_CYCLE' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger rt_column_dependencies before insert or update of depends_on on work.rt_column
  for each row execute function work.rt_column_dependencies();
grant execute on function work.rt_column_dependencies() to legallabs_app;
