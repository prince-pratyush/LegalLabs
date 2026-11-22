-- What a guest may read, opened one policy at a time. Everything else in the schema refuses a guest
-- because a guest is not an active member (0160). All of these are select-only: a guest creates and
-- changes nothing at the database level in this epic.

-- Three definer functions answered for anyone in the Space or workspace without asking whether the
-- caller is a member; a guest must not be able to probe them.
create or replace function work.user_in_space(p_space uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select core.is_active_member() and work.space_role(p_space) is not null and exists (
    select 1 from work.space_member m
     where m.space_id = p_space
       and m.workspace_id = core.current_workspace_id()
       and ((m.principal_type = 'user' and m.principal_id = p_user)
         or (m.principal_type = 'group' and exists (
               select 1 from core.group_member g
                where g.group_id = m.principal_id and g.user_id = p_user
                  and g.workspace_id = m.workspace_id)))
       and exists (select 1 from core."user" u
                    where u.id = p_user and u.workspace_id = m.workspace_id
                      and u.status = 'active' and u.kind = 'member'))
$$;

create or replace function work.phase_locked(p_phase uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select not ph.locked_override and exists (
      select 1 from work.phase prev
        join work.task t on t.space_id = prev.space_id and t.phase_id = prev.id
       where prev.space_id = ph.space_id
         and prev.ordinal = (select max(p.ordinal) from work.phase p
                              where p.space_id = ph.space_id and p.ordinal < ph.ordinal)
         and t.gate and t.status <> 'cancelled' and t.approved_at is null)
      from work.phase ph
     where ph.id = p_phase
       and ph.workspace_id = core.current_workspace_id()
       and core.is_active_member()
       and work.space_role(ph.space_id) is not null), false)
$$;

create or replace function work.vault_walled(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select core.is_active_member()
     and exists (select 1 from content.vault v
                  where v.id = p_id and v.workspace_id = core.current_workspace_id()
                    and not core.can_access_matter(v.matter_id))
$$;

-- Themselves, and the workspace's name for the footer ("Guest access · provided by ...").
create policy guest_self_read on core."user" for select to legallabs_app
  using (id = core.current_user_id() and workspace_id = core.current_workspace_id()
         and core.is_active_guest());
create policy guest_workspace_read on core.workspace for select to legallabs_app
  using (id = core.current_workspace_id() and core.is_active_guest());

-- The Space itself, once the connection is approved and the matter's wall lets them in.
create policy guest_space_read on work.space for select to legallabs_app
  using (workspace_id = core.current_workspace_id() and deleted_at is null
         and work.space_role(id) = 'guest');
create policy guest_member_read on work.space_member for select to legallabs_app
  using (workspace_id = core.current_workspace_id() and principal_type = 'user'
         and principal_id = core.current_user_id() and work.space_role(space_id) = 'guest');
-- A resource row appears only at a level for their own party, never the default or another party's.
create policy guest_resource_read on work.space_resource for select to legallabs_app
  using (workspace_id = core.current_workspace_id() and work.space_role(space_id) = 'guest'
         and work.guest_level(space_id, per_party) is not null);
-- Their own party and where its approval stands, before and after it is approved.
create policy guest_party_read on work.space_party for select to legallabs_app
  using (workspace_id = core.current_workspace_id() and id = work.my_party(space_id));
create policy guest_connection_read on work.space_connection for select to legallabs_app
  using (workspace_id = core.current_workspace_id() and party_id = work.my_party(space_id));

-- A vault is readable when it is shared into their Space at a level for their party, and the
-- vault's own matter wall (a second check, besides the Space's) lets them in.
create policy guest_vault_read on content.vault for select to legallabs_app
  using (workspace_id = core.current_workspace_id() and core.is_active_guest()
         and deleted_at is null and core.can_access_matter(matter_id)
         and core.has_access('vault', id, 'view'));

-- A guest's own sessions: made at login, read and ended by them. Expiry is enforced at the lookup.
create policy guest_session_insert on core.session for insert to legallabs_app
  with check (workspace_id = core.current_workspace_id() and user_id = core.current_user_id()
              and core.is_active_guest());
create policy guest_session_read on core.session for select to legallabs_app
  using (workspace_id = core.current_workspace_id() and user_id = core.current_user_id()
         and core.is_active_guest());
create policy guest_session_update on core.session for update to legallabs_app
  using (workspace_id = core.current_workspace_id() and user_id = core.current_user_id()
         and core.is_active_guest())
  with check (workspace_id = core.current_workspace_id() and user_id = core.current_user_id());
