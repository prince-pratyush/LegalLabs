-- Whether any turn of a thread asked for the web. Later turns carry earlier answers as history,
-- so nothing inferred from such a thread is kept as a memory. Once true it stays true.
alter table work.thread add column used_web boolean not null default false;
grant update (used_web) on work.thread to legallabs_app;

create function work.keep_used_web() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.used_web := old.used_web or new.used_web;
  return new;
end
$$;
create trigger keep_used_web before update of used_web on work.thread
  for each row execute function work.keep_used_web();
