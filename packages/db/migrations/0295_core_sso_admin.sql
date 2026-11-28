-- Setting up single sign-on on a running deployment.

-- Accounts are found by issuer and subject. Matching by email is now something to ask for.
alter table core.oidc_provider alter column link_by_email set default false;

-- A configured provider can vouch for any account linked to it, so changing it takes a full
-- administrator; admin.config may still read it.
drop policy oidc_provider_admin on core.oidc_provider;
create policy oidc_provider_read on core.oidc_provider for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.config'));
create policy oidc_provider_write on core.oidc_provider for all to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('*'))
  with check (core.in_tenant(workspace_id) and core.has_permission('*'));

-- The app seals the secret before it gets here. Not validated, so an old row does not stop the
-- upgrade; it can no longer be used and has to be entered again.
alter table core.oidc_provider_secret drop constraint oidc_provider_secret_client_secret_check;
alter table core.oidc_provider_secret add constraint oidc_provider_secret_client_secret_check
  check (char_length(client_secret) between 1 and 4096);
alter table core.oidc_provider_secret add constraint oidc_provider_secret_sealed
  check (client_secret like 'sealed:v1:%') not valid;

create or replace function core.set_oidc_client_secret(p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare ws uuid := core.current_workspace_id();
begin
  if ws is null or not core.in_tenant(ws) or not core.has_permission('*') then
    raise exception 'not allowed to configure single sign-on' using errcode = '42501';
  end if;
  if p_secret is null then
    delete from core.oidc_provider_secret where workspace_id = ws;
  else
    insert into core.oidc_provider_secret (workspace_id, client_secret) values (ws, p_secret)
    on conflict (workspace_id) do update set client_secret = excluded.client_secret;
  end if;
end
$$;

create function core.oidc_has_client_secret() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare ws uuid := core.current_workspace_id();
begin
  if not coalesce(core.in_tenant(ws) and core.has_permission('admin.config'), false) then
    raise exception 'not allowed to see single sign-on' using errcode = '42501';
  end if;
  return exists (select 1 from core.oidc_provider_secret s where s.workspace_id = ws);
end
$$;
alter function core.oidc_has_client_secret() owner to legallabs_definer;
grant execute on function core.oidc_has_client_secret() to legallabs_app;

-- For the sign-in under way: with single sign-on on, only full administrators keep a way in of
-- their own. The password lookup already applies this; passkey sign-in asks here.
create function core.own_sign_in_closed() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core.oidc_provider p
                  where p.workspace_id = core.current_workspace_id() and p.enabled)
     and not coalesce((
       select '*' = any (r.permissions)
         from core."user" u
         join core.role r on r.workspace_id = u.workspace_id and r.id = u.role_id
        where u.workspace_id = core.current_workspace_id() and u.id = core.current_user_id()), false)
$$;
alter function core.own_sign_in_closed() owner to legallabs_definer;
grant execute on function core.own_sign_in_closed() to legallabs_app;

-- As before (0103), except that email never attaches an identity to an account that has already
-- signed in through any provider (SEC-006).
create or replace function core.oidc_resolve_user(
  p_workspace uuid, p_issuer text, p_subject text, p_email text, p_email_verified boolean
) returns table (outcome text, user_id uuid, scim_enabled boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_scim boolean;
  v_link boolean;
  v_user uuid;
  v_status text;
begin
  select coalesce((w.settings ->> 'scim_enabled') = 'true', false) into v_scim
    from core.workspace w where w.id = p_workspace;
  select p.link_by_email into v_link from core.oidc_provider p
   where p.workspace_id = p_workspace and p.enabled and p.issuer = p_issuer;
  if not found then
    return query select 'no_provider', null::uuid, v_scim;
    return;
  end if;

  select u.id, u.status into v_user, v_status
    from core.external_identity e
    join core."user" u on u.workspace_id = e.workspace_id and u.id = e.user_id
   where e.workspace_id = p_workspace and e.issuer = p_issuer and e.subject = p_subject;
  if found then
    if v_status <> 'active' then
      return query select 'not_active', v_user, v_scim;
      return;
    end if;
    update core.external_identity e set last_login_at = now()
     where e.workspace_id = p_workspace and e.issuer = p_issuer and e.subject = p_subject;
    return query select 'ok', v_user, v_scim;
    return;
  end if;

  if not v_link or p_email is null then
    return query select 'unprovisioned', null::uuid, v_scim;
    return;
  end if;
  if not coalesce(p_email_verified, false) then
    return query select 'email_unverified', null::uuid, v_scim;
    return;
  end if;
  select u.id, u.status into v_user, v_status from core."user" u
   where u.workspace_id = p_workspace and lower(u.email) = lower(p_email) and u.kind = 'member';
  if not found then
    return query select 'unprovisioned', null::uuid, v_scim;
    return;
  end if;
  if v_status not in ('invited', 'active') then
    return query select 'not_active', v_user, v_scim;
    return;
  end if;
  if exists (select 1 from core.external_identity e
              where e.workspace_id = p_workspace and e.user_id = v_user) then
    return query select 'identity_conflict', v_user, v_scim;
    return;
  end if;
  insert into core.external_identity (workspace_id, user_id, issuer, subject, linked_via, last_login_at)
  values (p_workspace, v_user, p_issuer, p_subject, 'email', now())
  on conflict do nothing;
  if not found then
    return query select 'identity_conflict', v_user, v_scim;
    return;
  end if;
  if v_status = 'invited' then
    update core."user" u set status = 'active' where u.workspace_id = p_workspace and u.id = v_user;
  end if;
  return query select 'first_link', v_user, v_scim;
end
$$;
