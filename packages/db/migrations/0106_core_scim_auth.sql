-- Bearer lookup for /scim/v2. It answers only for a service user's token, and says why a
-- token that exists is still not usable so the API can audit a denied use.
create function scim.authenticate(p_token_hash bytea, p_ip inet)
returns table (token_id uuid, principal_id uuid, workspace_id uuid, scopes text[],
               enabled boolean, ip_allowed boolean)
language sql stable security definer set search_path = '' as $$
  select t.id, t.principal_id, t.workspace_id, t.scopes,
         coalesce(w.settings ->> 'scim_enabled', 'false') = 'true',
         -- No list means any address; otherwise the caller must sit inside one entry.
         case when jsonb_typeof(w.settings -> 'scim_ip_allowlist') = 'array'
                   and jsonb_array_length(w.settings -> 'scim_ip_allowlist') > 0
              then p_ip is not null and exists (
                     select 1 from jsonb_array_elements_text(w.settings -> 'scim_ip_allowlist') e
                      where p_ip <<= e::inet)
              else true end
    from core.api_token t
    join core."user" u on u.workspace_id = t.workspace_id and u.id = t.principal_id
    join core.workspace w on w.id = t.workspace_id
   where t.token_hash = p_token_hash
     and t.revoked_at is null
     and t.expires_at > now()
     and u.status = 'active'
     and u.kind = 'service'
$$;
alter function scim.authenticate(bytea, inet) owner to legallabs_definer;
grant execute on function scim.authenticate(bytea, inet) to legallabs_app;
