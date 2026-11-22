-- External Spaces (SPC-005): one guest-organisation party per Space, a two-sided connection that must
-- be approved before anything is visible to it, per-party levels on every shared resource, and the
-- guest membership rules. Everything that changes these rows is a definer function that checks the
-- caller; the app role has no write grant.

alter table work.space_member drop constraint space_member_role_check;
alter table work.space_member add constraint space_member_role_check
  check (role in ('admin', 'collaborator', 'guest'));
-- Null for the creating workspace (party 0); set for a guest.
alter table work.space_member add column party_id uuid;

create table work.space_party (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  space_id uuid not null,
  -- Linked workspaces need cross-workspace row security, which does not exist yet.
  kind text not null default 'guest_org' check (kind = 'guest_org'),
  name text not null check (char_length(name) between 1 and 200),
  domain text not null check (domain = lower(domain) and domain like '%.%' and domain !~ '[@[:space:]]'),
  -- Emails (in the party's domain) whose owner approves for the guest side once invited.
  connection_admin_emails text[] not null default '{}',
  connection_admin_ids uuid[] not null default '{}',
  opt_in_analytics boolean not null default false,
  -- A party group (kind 'party') holds the party's guests, so a wall can name the whole party.
  group_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, space_id) references work.space (workspace_id, id) on delete cascade,
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id)
);
-- At most one live external party per Space.
create unique index space_party_live_idx on work.space_party (space_id) where removed_at is null;

alter table work.space_member add constraint space_member_party_fk
  foreign key (workspace_id, party_id) references work.space_party (workspace_id, id);

create table work.space_connection (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  space_id uuid not null,
  party_id uuid not null unique,
  status text not null default 'action_required'
    check (status in ('action_required', 'in_progress', 'resolved', 'rejected')),
  -- [{side: internal|external, user_id, at}]
  approvals jsonb not null default '[]' check (jsonb_typeof(approvals) = 'array'),
  rejected_reason text check (char_length(rejected_reason) <= 1000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (workspace_id, party_id) references work.space_party (workspace_id, id) on delete cascade,
  foreign key (workspace_id, space_id) references work.space (workspace_id, id) on delete cascade
);

create table work.guest_invite (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  space_id uuid not null,
  party_id uuid not null,
  email text not null check (email like '%_@_%'),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  invited_by uuid not null,
  -- How long the guest account lasts once accepted.
  access_days integer not null default 90 check (access_days between 1 and 365),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_user_id uuid,
  revoked_at timestamptz,
  foreign key (workspace_id, party_id) references work.space_party (workspace_id, id) on delete cascade,
  foreign key (workspace_id, space_id) references work.space (workspace_id, id) on delete cascade
);
create index guest_invite_space_idx on work.guest_invite (space_id, created_at desc);

alter table work.space_party enable row level security;
alter table work.space_party force row level security;
alter table work.space_connection enable row level security;
alter table work.space_connection force row level security;
alter table work.guest_invite enable row level security;
alter table work.guest_invite force row level security;

grant select, insert, update, delete on work.space_party, work.space_connection, work.guest_invite
  to legallabs_definer;
create policy definer_all on work.space_party for all to legallabs_definer using (true) with check (true);
create policy definer_all on work.space_connection for all to legallabs_definer using (true) with check (true);
create policy definer_all on work.guest_invite for all to legallabs_definer using (true) with check (true);
grant insert on core."group", core.group_member to legallabs_definer;
create policy definer_party_group on core."group" for insert to legallabs_definer
  with check (kind = 'party');
create policy definer_party_member on core.group_member for insert to legallabs_definer
  with check (exists (select 1 from core."group" g where g.id = group_id and g.kind = 'party'));
grant update, delete on work.space_member to legallabs_definer;
create policy definer_change on work.space_member for update to legallabs_definer using (true) with check (true);
create policy definer_delete on work.space_member for delete to legallabs_definer using (true);
-- core.session already lets the definer revoke (0105).

-- Members of the Space read its party and connection; Connection Admins read every connection.
grant select on work.space_party, work.space_connection, work.guest_invite to legallabs_app;
create policy party_read on work.space_party for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (work.space_role(space_id) is not null or core.has_permission('spaces.connections')));
create policy connection_read on work.space_connection for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (work.space_role(space_id) is not null or core.has_permission('spaces.connections')));
-- Invites carry the address of someone outside: Space admins only.
create policy invite_read on work.guest_invite for select to legallabs_app
  using (core.in_tenant(workspace_id) and work.space_role(space_id) = 'admin');

-- The party's connection is approved by both sides and the party is still part of the Space.
create function work.party_live(p_space uuid, p_party uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from work.space_party p join work.space_connection c on c.party_id = p.id
     where p.id = p_party and p.space_id = p_space and p.removed_at is null
       and c.status = 'resolved')
$$;
alter function work.party_live(uuid, uuid) owner to legallabs_definer;
grant execute on function work.party_live(uuid, uuid) to legallabs_app, legallabs_definer;

-- A guest's party in a Space, whether or not its connection is approved yet (needed to approve).
create function work.my_party(p_space uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select m.party_id from work.space_member m
   where m.space_id = p_space and m.principal_type = 'user' and m.role = 'guest'
     and m.principal_id = core.current_user_id()
     and m.workspace_id = core.current_workspace_id()
     and core.is_active_guest()
$$;
alter function work.my_party(uuid) owner to legallabs_definer;
grant execute on function work.my_party(uuid) to legallabs_app;

-- Spec §4.3: the party's own level, never above Edit for a guest. A party with no entry gets nothing,
-- so a resource reaches outside only when someone said so for that party.
create function work.guest_level(p_space uuid, p_per_party jsonb) returns text
language sql stable security definer set search_path = '' as $$
  select case when x.lv is null or x.lv = 'none' then null
              when core.level_rank(x.lv) > 3 then 'edit'
              else x.lv end
    from (select p_per_party ->> m.party_id::text as lv
            from work.space_member m
           where m.space_id = p_space and m.principal_type = 'user' and m.role = 'guest'
             and m.principal_id = core.current_user_id()
             and m.workspace_id = core.current_workspace_id()
           limit 1) x
$$;
alter function work.guest_level(uuid, jsonb) owner to legallabs_definer;
grant execute on function work.guest_level(uuid, jsonb) to legallabs_app, legallabs_definer;

-- The caller's role in a live Space: a member directly or by group, or a live guest whose party is
-- connected. Walls decide for both.
create or replace function work.space_membership(p_space uuid) returns text
language sql stable security definer set search_path = '' as $$
  with me as (
    select u.id, u.workspace_id, u.kind from core."user" u
     where u.id = core.current_user_id()
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active'
       and (u.kind = 'member' or (u.kind = 'guest' and core.guest_live(u.id)))
  )
  select (select m.role
            from work.space_member m
            join me on m.workspace_id = me.workspace_id
            join work.space s on s.id = m.space_id and s.workspace_id = m.workspace_id
           where m.space_id = p_space
             and s.deleted_at is null
             and core.can_access_matter(s.matter_id)
             and ((me.kind = 'member' and m.role <> 'guest'
                   and ((m.principal_type = 'user' and m.principal_id = me.id)
                     or (m.principal_type = 'group' and exists (
                           select 1 from core.group_member g
                            where g.group_id = m.principal_id and g.user_id = me.id
                              and g.workspace_id = me.workspace_id))))
               or (me.kind = 'guest' and m.role = 'guest' and m.principal_type = 'user'
                   and m.principal_id = me.id and s.kind = 'external'
                   and work.party_live(m.space_id, m.party_id)))
           order by (m.role = 'admin') desc
           limit 1)
$$;

-- Guests reach content only through a Space, at their party's level; direct, group and workspace
-- grants never reach them. Members are unchanged. Walls are checked by the callers, on the object.
create or replace function core.has_access(object_type text, object_id uuid, level text) returns boolean
language sql stable security definer set search_path = '' as $$
  with me as (
    select u.id, u.workspace_id, u.kind from core."user" u
     where u.id = core.current_user_id()
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active'
       and (u.kind <> 'guest' or core.guest_live(u.id))
  )
  select exists (
    select 1 from core.share_grant g join me on g.workspace_id = me.workspace_id
     where me.kind <> 'guest'
       and g.object_type = has_access.object_type
       and g.object_id = has_access.object_id
       and g.suspended_reason is null
       and (g.expires_at is null or g.expires_at > now())
       -- An unknown level ranks as null, so the comparison fails closed.
       and core.level_rank(g.level) >= core.level_rank(has_access.level)
       and ((g.principal_type = 'user' and g.principal_id = me.id)
         or (g.principal_type = 'group' and exists (
               select 1 from core.group_member m
                where m.group_id = g.principal_id and m.user_id = me.id
                  and m.workspace_id = me.workspace_id))
         or (g.principal_type = 'workspace' and g.principal_id = me.workspace_id
             and me.kind = 'member')))
  or exists (
    select 1 from work.space_resource r join me on r.workspace_id = me.workspace_id
     where r.resource_type = has_access.object_type
       and r.resource_id = has_access.object_id
       and r.suspended_reason is null
       and core.level_rank(case when me.kind = 'guest' then work.guest_level(r.space_id, r.per_party)
                                else r.access end)
           >= core.level_rank(has_access.level)
       and work.space_membership(r.space_id) is not null)
$$;

-- What may be shared outward is checked where the row is written, not only by the API.
create function work.guard_resource_party() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  k text;
  v text;
  party record;
begin
  if new.per_party = '{}'::jsonb then
    return new;
  end if;
  if not exists (select 1 from work.space s where s.id = new.space_id and s.kind = 'external') then
    raise exception 'PER_PARTY_NEEDS_EXTERNAL_SPACE' using errcode = 'check_violation';
  end if;
  for k, v in select key, value #>> '{}' from jsonb_each(new.per_party) loop
    if v is null or v not in ('none', 'view', 'run', 'edit', 'full') then
      raise exception 'INVALID_PARTY_LEVEL' using errcode = 'check_violation';
    end if;
    select p.id, c.status into party
      from work.space_party p join work.space_connection c on c.party_id = p.id
     where p.space_id = new.space_id and p.removed_at is null and p.id::text = k;
    if not found then
      raise exception 'UNKNOWN_PARTY' using errcode = 'check_violation';
    end if;
    -- Nothing leaves before both sides have approved the connection.
    if v <> 'none' and party.status <> 'resolved' then
      raise exception 'CONNECTION_NOT_APPROVED' using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end
$$;
alter function work.guard_resource_party() owner to legallabs_definer;
create trigger space_resource_party before insert or update of per_party on work.space_resource
  for each row execute function work.guard_resource_party();

-- Guests are only members of an external Space, as guests, with a party. Members never carry one.
create function work.guard_space_member() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  kind text;
begin
  select u.kind into kind from core."user" u
   where new.principal_type = 'user' and u.id = new.principal_id and u.workspace_id = new.workspace_id;
  if kind = 'guest' or new.role = 'guest' then
    if kind is distinct from 'guest' or new.role <> 'guest' or new.party_id is null
       or not exists (select 1 from work.space s
                       where s.id = new.space_id and s.kind = 'external') then
      raise exception 'GUEST_MEMBERSHIP_INVALID' using errcode = 'check_violation';
    end if;
  elsif new.party_id is not null then
    raise exception 'GUEST_MEMBERSHIP_INVALID' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function work.guard_space_member() owner to legallabs_definer;
create trigger space_member_guard_guest before insert or update on work.space_member
  for each row execute function work.guard_space_member();

-- When a party goes, its guests lose the Space at once; a guest with no Space left loses every session.
create function work.drop_party_guests(p_party uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  gone uuid[];
begin
  select coalesce(array_agg(m.principal_id), '{}') into gone
    from work.space_member m where m.party_id = p_party and m.role = 'guest';
  delete from work.space_member where party_id = p_party;
  update work.guest_invite set revoked_at = now()
   where party_id = p_party and accepted_at is null and revoked_at is null;
  update core.session s set revoked_at = now()
   where s.user_id = any (gone) and s.revoked_at is null
     and not exists (select 1 from work.space_member m
                      where m.principal_type = 'user' and m.principal_id = s.user_id);
  update core.guest_profile set last_in_space_at = now() where user_id = any (gone);
end
$$;
alter function work.drop_party_guests(uuid) owner to legallabs_definer;
grant execute on function work.drop_party_guests(uuid) to legallabs_definer;

create function work.add_party(p_space uuid, p_name text, p_domain text, p_admin_emails text[] default '{}')
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  pid uuid;
  gid uuid;
  dom text := lower(btrim(p_domain));
  addr text;
begin
  if work.space_role(p_space) is distinct from 'admin' or not core.has_permission('spaces.external') then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from work.space s
                  where s.id = p_space and s.kind = 'external' and s.deleted_at is null
                    and s.workspace_id = core.current_workspace_id()) then
    raise exception 'SPACE_NOT_EXTERNAL' using errcode = 'check_violation';
  end if;
  if exists (select 1 from work.space_party p where p.space_id = p_space and p.removed_at is null) then
    raise exception 'PARTY_LIMIT' using errcode = 'check_violation';
  end if;
  foreach addr in array coalesce(p_admin_emails, '{}') loop
    if lower(split_part(addr, '@', 2)) <> dom then
      raise exception 'GUEST_DOMAIN_MISMATCH' using errcode = 'check_violation';
    end if;
  end loop;
  pid := core.uuid7();
  insert into core."group" (workspace_id, name, kind, visibility)
  values (core.current_workspace_id(), left(btrim(p_name), 150) || ' · party ' || left(pid::text, 8),
          'party', 'private')
  returning id into gid;
  insert into work.space_party (id, workspace_id, space_id, name, domain, connection_admin_emails,
                                group_id, created_by)
  values (pid, core.current_workspace_id(), p_space, p_name, dom,
          (select coalesce(array_agg(distinct lower(a)), '{}') from unnest(coalesce(p_admin_emails, '{}')) a),
          gid, core.current_user_id());
  insert into work.space_connection (workspace_id, space_id, party_id)
  values (core.current_workspace_id(), p_space, pid);
  return pid;
end
$$;

-- Removing a party, or changing its domain, ends what was approved: guests go and the flow restarts.
create function work.remove_party(p_space uuid, p_party uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if work.space_role(p_space) is distinct from 'admin' then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  update work.space_party set removed_at = now()
   where id = p_party and space_id = p_space and removed_at is null
     and workspace_id = core.current_workspace_id();
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'no_data_found';
  end if;
  update work.space_connection set status = 'rejected', rejected_reason = 'party removed'
   where party_id = p_party and status <> 'rejected';
  perform work.drop_party_guests(p_party);
end
$$;

create function work.set_party_domain(p_space uuid, p_party uuid, p_domain text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  dom text := lower(btrim(p_domain));
begin
  if work.space_role(p_space) is distinct from 'admin' or not core.has_permission('spaces.external') then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  update work.space_party set domain = dom, connection_admin_ids = '{}',
         connection_admin_emails = (select coalesce(array_agg(a), '{}')
                                      from unnest(connection_admin_emails) a
                                     where lower(split_part(a, '@', 2)) = dom)
   where id = p_party and space_id = p_space and removed_at is null
     and workspace_id = core.current_workspace_id();
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'no_data_found';
  end if;
  update work.space_connection set status = 'action_required', approvals = '[]',
         resolved_at = null, rejected_reason = null
   where party_id = p_party;
  perform work.drop_party_guests(p_party);
end
$$;

-- Which side the caller approves for: a Connection Admin of this workspace, or the party's own.
create function work.connection_side(p_space uuid, p_party uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when core.has_permission('spaces.connections')
         and exists (select 1 from work.space s
                      where s.id = p_space and s.workspace_id = core.current_workspace_id())
      then 'internal'
    when core.is_active_guest() and exists (
           select 1 from work.space_party p
             join work.space_member m on m.party_id = p.id and m.space_id = p.space_id
            where p.id = p_party and p.space_id = p_space and p.removed_at is null
              and m.principal_type = 'user' and m.principal_id = core.current_user_id()
              and m.role = 'guest'
              and core.current_user_id() = any (p.connection_admin_ids))
      then 'external'
  end
$$;
alter function work.connection_side(uuid, uuid) owner to legallabs_definer;
grant execute on function work.connection_side(uuid, uuid) to legallabs_definer;

create function work.approve_connection(p_space uuid, p_party uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  side text := work.connection_side(p_space, p_party);
  c record;
  done jsonb;
  new_status text;
begin
  if side is null then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  select * into c from work.space_connection
   where party_id = p_party and space_id = p_space and workspace_id = core.current_workspace_id()
   for update;
  if not found or not exists (select 1 from work.space_party p
                               where p.id = p_party and p.removed_at is null) then
    raise exception 'NOT_FOUND' using errcode = 'no_data_found';
  end if;
  if c.status not in ('action_required', 'in_progress') then
    raise exception 'CONNECTION_NOT_PENDING' using errcode = 'check_violation';
  end if;
  if exists (select 1 from jsonb_array_elements(c.approvals) a where a ->> 'side' = side) then
    raise exception 'ALREADY_APPROVED' using errcode = 'check_violation';
  end if;
  done := c.approvals || jsonb_build_array(jsonb_build_object(
            'side', side, 'user_id', core.current_user_id(), 'at', now()));
  new_status := case when (select count(distinct a ->> 'side') from jsonb_array_elements(done) a) = 2
               then 'resolved' else 'in_progress' end;
  update work.space_connection set approvals = done, status = new_status,
         resolved_at = case when new_status = 'resolved' then now() end
   where id = c.id;
  return new_status;
end
$$;

create function work.reject_connection(p_space uuid, p_party uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  side text := work.connection_side(p_space, p_party);
begin
  if side is null then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  update work.space_connection set status = 'rejected', rejected_reason = left(p_reason, 1000),
         resolved_at = null
   where party_id = p_party and space_id = p_space and workspace_id = core.current_workspace_id()
     and status in ('action_required', 'in_progress', 'resolved');
  if not found then
    raise exception 'CONNECTION_NOT_PENDING' using errcode = 'check_violation';
  end if;
  update work.space_party set removed_at = now() where id = p_party and removed_at is null;
  perform work.drop_party_guests(p_party);
end
$$;

-- Invites: a Space admin with spaces.invite, only to an address in the party's domain.
create function work.invite_guest(p_space uuid, p_email text, p_token_hash bytea, p_access_days integer default 90)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  party record;
  addr text := lower(btrim(p_email));
  iid uuid;
begin
  if work.space_role(p_space) is distinct from 'admin' or not core.has_permission('spaces.invite') then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  select p.id, p.domain, c.status into party
    from work.space_party p join work.space_connection c on c.party_id = p.id
   where p.space_id = p_space and p.removed_at is null
     and p.workspace_id = core.current_workspace_id();
  if not found then
    raise exception 'NO_PARTY' using errcode = 'check_violation';
  end if;
  if addr not like '%_@_%' or lower(split_part(addr, '@', 2)) <> party.domain then
    raise exception 'GUEST_DOMAIN_MISMATCH' using errcode = 'check_violation';
  end if;
  if exists (select 1 from core."user" u
              where u.workspace_id = core.current_workspace_id() and lower(u.email) = addr
                and u.kind <> 'guest') then
    raise exception 'EMAIL_IS_MEMBER' using errcode = 'check_violation';
  end if;
  update work.guest_invite set revoked_at = now()
   where space_id = p_space and lower(email) = addr and accepted_at is null and revoked_at is null;
  insert into work.guest_invite (workspace_id, space_id, party_id, email, token_hash, invited_by,
                                 access_days, expires_at)
  values (core.current_workspace_id(), p_space, party.id, addr, p_token_hash, core.current_user_id(),
          p_access_days, now() + interval '7 days')
  returning id into iid;
  return iid;
end
$$;

create function work.revoke_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update work.guest_invite i set revoked_at = now()
   where i.id = p_invite and i.accepted_at is null and i.revoked_at is null
     and i.workspace_id = core.current_workspace_id()
     and work.space_role(i.space_id) = 'admin';
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'no_data_found';
  end if;
end
$$;

-- Before login, so no identity: the token is the credential. Says only what the accept screen needs.
create function work.preview_guest_invite(p_token_hash bytea)
returns table (email text, space_name text, workspace_name text, party_name text, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.email, s.name, w.name, p.name, i.expires_at
    from work.guest_invite i
    join work.space s on s.id = i.space_id
    join work.space_party p on p.id = i.party_id
    join core.workspace w on w.id = i.workspace_id
   where i.token_hash = p_token_hash and i.accepted_at is null and i.revoked_at is null
     and i.expires_at > now() and p.removed_at is null and s.deleted_at is null
$$;

create function work.accept_guest_invite(p_token_hash bytea, p_name text)
returns table (user_id uuid, workspace_id uuid, workspace_slug text, space_id uuid)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  i record;
  uid uuid;
  slug text;
begin
  select v.*, p.domain, p.connection_admin_emails, p.group_id into i
    from work.guest_invite v
    join work.space_party p on p.id = v.party_id
    join work.space s on s.id = v.space_id
   where v.token_hash = p_token_hash and v.accepted_at is null and v.revoked_at is null
     and v.expires_at > now() and p.removed_at is null and s.deleted_at is null
   for update of v;
  if not found then
    raise exception 'INVITE_INVALID' using errcode = 'check_violation';
  end if;
  if lower(split_part(i.email, '@', 2)) <> i.domain then
    raise exception 'GUEST_DOMAIN_MISMATCH' using errcode = 'check_violation';
  end if;
  select u.id into uid from core."user" u
   where u.workspace_id = i.workspace_id and lower(u.email) = lower(i.email);
  if uid is not null and not exists (select 1 from core."user" u where u.id = uid and u.kind = 'guest') then
    raise exception 'EMAIL_IS_MEMBER' using errcode = 'check_violation';
  end if;
  if uid is null then
    -- No role and no extra permissions: the table's own check makes that the only possible guest.
    insert into core."user" (workspace_id, email, name, status, kind)
    values (i.workspace_id, lower(i.email), left(btrim(coalesce(p_name, '')), 200), 'active', 'guest')
    returning id into uid;
    insert into core.guest_profile (workspace_id, user_id, email_domain, invited_by, expires_at)
    values (i.workspace_id, uid, i.domain, i.invited_by, now() + make_interval(days => i.access_days));
  else
    -- A returning guest is reactivated, with a fresh term.
    update core."user" set status = 'active', name = case when btrim(coalesce(p_name, '')) <> ''
                                                     then left(btrim(p_name), 200) else name end
     where id = uid;
    update core.guest_profile set deactivated_at = null, locked_until = null, failed_codes = 0,
           last_in_space_at = now(), expires_at = now() + make_interval(days => i.access_days)
     where user_id = uid;
  end if;
  insert into work.space_member (workspace_id, space_id, principal_type, principal_id, role, invited_by, party_id)
  values (i.workspace_id, i.space_id, 'user', uid, 'guest', i.invited_by, i.party_id)
  on conflict (space_id, principal_type, principal_id) do nothing;
  if i.group_id is not null then
    insert into core.group_member (workspace_id, group_id, user_id)
    values (i.workspace_id, i.group_id, uid) on conflict do nothing;
  end if;
  if lower(i.email) = any (i.connection_admin_emails) then
    update work.space_party set connection_admin_ids = array_append(connection_admin_ids, uid)
     where id = i.party_id and not (uid = any (connection_admin_ids));
  end if;
  update work.guest_invite set accepted_at = now(), accepted_user_id = uid where id = i.id;
  select w.slug into slug from core.workspace w where w.id = i.workspace_id;
  return query select uid, i.workspace_id, slug, i.space_id;
end
$$;

-- A Space admin removes one guest; the guest keeps their account but loses this Space, and every
-- session if it was their last.
create function work.remove_guest(p_space uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if work.space_role(p_space) is distinct from 'admin' then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  delete from work.space_member
   where space_id = p_space and principal_type = 'user' and principal_id = p_user and role = 'guest'
     and workspace_id = core.current_workspace_id();
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'no_data_found';
  end if;
  update core.session s set revoked_at = now()
   where s.user_id = p_user and s.revoked_at is null
     and not exists (select 1 from work.space_member m
                      where m.principal_type = 'user' and m.principal_id = p_user);
  update core.guest_profile set last_in_space_at = now() where user_id = p_user;
end
$$;

-- The guests of a Space: who, which party, until when. Never another Space's.
create function work.space_guests(p_space uuid)
returns table (user_id uuid, email text, name text, party_id uuid, expires_at timestamptz, status text)
language sql stable security definer set search_path = '' as $$
  select u.id, u.email, u.name, m.party_id, p.expires_at,
         case when p.deactivated_at is not null then 'deactivated'
              when p.expires_at <= now() then 'expired' else 'active' end
    from work.space_member m
    join core."user" u on u.id = m.principal_id and u.workspace_id = m.workspace_id
    join core.guest_profile p on p.user_id = u.id and p.workspace_id = u.workspace_id
   where m.space_id = p_space and m.role = 'guest'
     and m.workspace_id = core.current_workspace_id()
     and work.space_role(p_space) = 'admin'
   order by u.email
$$;

-- What a guest sees of the Spaces they were invited to: the party's name and where its approval
-- stands, even before the connection is approved (the Space itself stays hidden until then).
create function work.my_guest_spaces()
returns table (space_id uuid, space_name text, party_id uuid, party_name text, connection_status text,
               can_approve boolean, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.id, s.name, p.id, p.name, c.status,
         core.current_user_id() = any (p.connection_admin_ids)
           and c.status in ('action_required', 'in_progress'),
         gp.expires_at
    from work.space_member m
    join work.space s on s.id = m.space_id and s.workspace_id = m.workspace_id
    join work.space_party p on p.id = m.party_id
    join work.space_connection c on c.party_id = p.id
    join core.guest_profile gp on gp.user_id = m.principal_id and gp.workspace_id = m.workspace_id
   where m.principal_type = 'user' and m.principal_id = core.current_user_id()
     and m.workspace_id = core.current_workspace_id()
     and m.role = 'guest' and s.deleted_at is null and p.removed_at is null
     and core.is_active_guest()
   order by s.name
$$;

-- Guests with nothing left to do are deactivated: expired, or without a Space for 30 days.
create function core.sweep_guests() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  if not core.has_permission('admin.users') then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  with gone as (
    update core.guest_profile p set deactivated_at = now()
     where p.workspace_id = core.current_workspace_id() and p.deactivated_at is null
       and (p.expires_at <= now()
            or (p.last_in_space_at < now() - interval '30 days'
                and not exists (select 1 from work.space_member m
                                 where m.principal_type = 'user' and m.principal_id = p.user_id)))
    returning p.user_id
  ), off as (
    update core."user" u set status = 'suspended' from gone
     where u.id = gone.user_id returning u.id
  ), revoked as (
    update core.session s set revoked_at = now()
     where s.user_id in (select id from off) and s.revoked_at is null
    returning s.id
  )
  select count(*) into n from off;
  return n;
end
$$;

alter function work.add_party(uuid, text, text, text[]) owner to legallabs_definer;
alter function work.remove_party(uuid, uuid) owner to legallabs_definer;
alter function work.set_party_domain(uuid, uuid, text) owner to legallabs_definer;
alter function work.approve_connection(uuid, uuid) owner to legallabs_definer;
alter function work.reject_connection(uuid, uuid, text) owner to legallabs_definer;
alter function work.invite_guest(uuid, text, bytea, integer) owner to legallabs_definer;
alter function work.revoke_invite(uuid) owner to legallabs_definer;
alter function work.preview_guest_invite(bytea) owner to legallabs_definer;
alter function work.accept_guest_invite(bytea, text) owner to legallabs_definer;
alter function work.remove_guest(uuid, uuid) owner to legallabs_definer;
alter function work.space_guests(uuid) owner to legallabs_definer;
alter function work.my_guest_spaces() owner to legallabs_definer;
alter function core.sweep_guests() owner to legallabs_definer;
grant execute on function work.add_party(uuid, text, text, text[]), work.remove_party(uuid, uuid),
  work.set_party_domain(uuid, uuid, text), work.approve_connection(uuid, uuid),
  work.reject_connection(uuid, uuid, text), work.invite_guest(uuid, text, bytea, integer),
  work.revoke_invite(uuid), work.preview_guest_invite(bytea), work.accept_guest_invite(bytea, text),
  work.remove_guest(uuid, uuid), work.space_guests(uuid), work.my_guest_spaces(),
  core.sweep_guests() to legallabs_app;
