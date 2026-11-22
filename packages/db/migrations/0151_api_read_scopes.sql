-- Scope-based reads for API tokens. A service account never holds admin permissions, so a token
-- reads audit events and query history through its scope instead. The API sets app.api_scopes
-- (comma-separated) for the length of one transaction, only after it has verified the token;
-- a signed-in person's requests never set it, so for them these policies grant nothing.
create function core.has_api_scope(scope text) returns boolean
language sql stable as $$
  select scope = any (string_to_array(coalesce(current_setting('app.api_scopes', true), ''), ','))
$$;
grant execute on function core.has_api_scope(text) to legallabs_app;

create policy audit_event_api_read on admin.audit_event for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_api_scope('audit:read'));

-- Query history is the usage log: ids, counts and labels, never the question itself.
create policy usage_event_api_read on analytics.usage_event for select to legallabs_app
  using (core.in_tenant(workspace_id) and action_class = 'query'
         and core.has_api_scope('history:read'));

create index usage_event_query_idx on analytics.usage_event (workspace_id, id desc)
  where action_class = 'query';
