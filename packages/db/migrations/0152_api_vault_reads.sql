-- A service account may read the vaults someone shared with it by name (ADM-009, vaults:read).
-- Until now only members reached vaults. Guests still don't, and a service account never gains a
-- workspace-wide share (has_access keeps that for members) or an open matter: it sees a vault
-- only through a share naming it, and past a matter's wall only through an explicit allow.
create or replace function content.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core."user" u
                  where u.id = core.current_user_id() and u.kind in ('member', 'service'))
$$;
