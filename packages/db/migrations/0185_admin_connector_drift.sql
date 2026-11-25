-- A tool call re-reads the server's manifest (CON-001). When it no longer matches the pin, the
-- connector has to shut at once, but the person whose run noticed cannot write connectors. The
-- worker role gets one narrow function that can only disable an enabled connector.
grant select, update (status, disabled_reason, updated_at) on admin.connector to legallabs_definer;
create policy connector_definer_read on admin.connector for select to legallabs_definer using (true);
create policy connector_definer_drift on admin.connector for update to legallabs_definer
  using (true) with check (status = 'disabled');

create function admin.report_connector_drift(p_workspace uuid, p_connector uuid) returns boolean
language sql security definer set search_path = '' as $$
  with shut as (
    update admin.connector
       set status = 'disabled', disabled_reason = 'CONNECTOR_MANIFEST_CHANGED', updated_at = now()
     where workspace_id = p_workspace and id = p_connector and status = 'enabled'
    returning 1)
  select exists (select 1 from shut)
$$;
alter function admin.report_connector_drift(uuid, uuid) owner to legallabs_definer;
revoke execute on function admin.report_connector_drift(uuid, uuid) from public;
grant execute on function admin.report_connector_drift(uuid, uuid) to legallabs_worker;
