-- Once single sign-on is on, only admins keep a password, as the way back in if the IdP is down.
create or replace function core.find_login_credential(workspace_slug text, email text)
returns table (workspace_id uuid, user_id uuid, status text, password_hash text)
language sql stable security definer set search_path = '' as $$
  select w.id, u.id, u.status,
         case when exists (select 1 from core.oidc_provider p
                            where p.workspace_id = w.id and p.enabled)
                   and not coalesce('*' = any (r.permissions), false)
              then null else c.password_hash end
    from core.workspace w
    left join core."user" u
      on u.workspace_id = w.id
     and lower(u.email) = lower(find_login_credential.email)
     and u.kind = 'member'
    left join core.role r on r.workspace_id = u.workspace_id and r.id = u.role_id
    left join core.password_credential c
      on c.workspace_id = u.workspace_id and c.user_id = u.id
   where w.slug = find_login_credential.workspace_slug
$$;
