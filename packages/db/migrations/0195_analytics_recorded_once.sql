-- Keys of events that must count once however often the action repeats: a suggestion applied
-- again, a draft exported again, an add-in action sent in several requests. A key is made of
-- ids only. The claim and the event it guards are written in one transaction.
create table analytics.recorded_once (
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  key text not null check (char_length(key) between 1 and 200),
  at timestamptz not null default now(),
  primary key (workspace_id, key)
);
alter table analytics.recorded_once owner to legallabs_definer;
alter table analytics.recorded_once enable row level security;
alter table analytics.recorded_once force row level security;
create policy definer_all on analytics.recorded_once for all to legallabs_definer
  using (true) with check (true);
grant select, insert, update, delete on analytics.recorded_once to legallabs_definer;

-- True the first time a key is claimed in the caller's workspace, false after.
create function analytics.claim_once(p_key text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
begin
  if core.current_user_id() is null or ws is null
     or not (core.in_tenant(ws) or core.is_active_guest()) then
    raise exception 'usage needs a signed-in member' using errcode = '42501';
  end if;
  insert into analytics.recorded_once (workspace_id, key) values (ws, p_key)
  on conflict do nothing;
  return found;
end
$$;
alter function analytics.claim_once(text) owner to legallabs_definer;
grant execute on function analytics.claim_once(text) to legallabs_app;
