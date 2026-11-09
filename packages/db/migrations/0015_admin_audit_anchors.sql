create table admin.audit_anchor (
  workspace_id uuid not null references core.workspace (id),
  day date not null,
  last_seq bigint not null,
  last_hash bytea not null,
  storage_key text not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, day)
);
alter table admin.audit_anchor owner to legallabs_definer;
alter table admin.audit_anchor enable row level security;
alter table admin.audit_anchor force row level security;

grant select on admin.audit_anchor to legallabs_app;
create policy audit_anchor_read on admin.audit_anchor for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.audit'));
create policy audit_anchor_definer on admin.audit_anchor for all to legallabs_definer
  using (workspace_id = core.current_workspace_id())
  with check (workspace_id = core.current_workspace_id());
create policy audit_event_definer_read on admin.audit_event for select to legallabs_definer
  using (workspace_id = core.current_workspace_id());

create trigger audit_anchor_immutable before update or delete on admin.audit_anchor
  for each row execute function admin.reject_audit_change();
create trigger audit_anchor_no_truncate before truncate on admin.audit_anchor
  for each statement execute function admin.reject_audit_change();
revoke delete, truncate on admin.audit_anchor from legallabs_definer;

create function admin.record_audit_anchor(p_day date)
returns table (day date, last_seq bigint, last_hash bytea, storage_key text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  ws uuid := core.current_workspace_id();
begin
  if ws is null then
    raise exception 'audit anchor needs a workspace' using errcode = '42501';
  end if;
  -- An open day's last hash would still change.
  if p_day >= (now() at time zone 'UTC')::date then
    raise exception 'audit anchors are only for finished days' using errcode = '22023';
  end if;

  -- Waits out writers, so an event stamped before midnight can't commit after this anchor.
  perform 1 from admin.audit_head h where h.workspace_id = ws for update;

  insert into admin.audit_anchor (workspace_id, day, last_seq, last_hash, storage_key)
  select ws, p_day, e.seq, e.hash, format('audit-anchors/%s/%s.json', ws, p_day)
    from admin.audit_event e
   where e.workspace_id = ws
     and e.at < (p_day + 1)::timestamp at time zone 'UTC'
   order by e.at desc, e.seq desc
   limit 1
  on conflict do nothing;

  return query
    select a.day, a.last_seq, a.last_hash, a.storage_key
      from admin.audit_anchor a
     where a.workspace_id = ws and a.day = p_day;
end
$$;
alter function admin.record_audit_anchor(date) owner to legallabs_definer;
grant execute on function admin.record_audit_anchor(date) to legallabs_app;
