-- Public API tokens (ADM-009). The table and its hashed-secret lookup came with the first
-- sessions; this adds what a public token needs on top: a network restriction and a link from a
-- rotated token to the one it replaced. Secrets are still never stored, only their SHA-256.
alter table core.api_token
  add column cidrs cidr[] not null default '{}' check (cardinality(cidrs) <= 50),
  add column rotated_from uuid references core.api_token (id);

-- Rotation shortens the old token to a 24 h overlap, so an admin may move its expiry earlier.
grant update (expires_at) on core.api_token to legallabs_app;

-- Public tokens only: SCIM tokens carry the 'scim' scope and have their own lookup.
create function core.resolve_public_token(token_hash bytea)
returns table (token_id uuid, principal_id uuid, workspace_id uuid, scopes text[],
               expires_at timestamptz, cidrs text[])
language sql stable security definer set search_path = '' as $$
  select t.id, t.principal_id, t.workspace_id, t.scopes, t.expires_at, t.cidrs::text[]
    from core.api_token t
    join core."user" u on u.workspace_id = t.workspace_id and u.id = t.principal_id
   where t.token_hash = resolve_public_token.token_hash
     and t.revoked_at is null
     and t.expires_at > now()
     and u.status = 'active'
     and u.kind = 'service'
     and not ('scim' = any (t.scopes))
$$;
alter function core.resolve_public_token(bytea) owner to legallabs_definer;
grant execute on function core.resolve_public_token(bytea) to legallabs_app;
