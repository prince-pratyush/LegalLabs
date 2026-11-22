-- Guests (SPC-004): Space-only accounts. The rule that keeps them out of everything else is one
-- line: a guest is not an "active member". Every policy and definer function in the schema asks
-- core.is_active_member() (directly or through core.in_tenant), so a guest passes none of them,
-- including tables and functions added later. What a guest may reach is opened one policy at a time
-- (0162), and expiry is checked wherever a guest is let in.

create table core.guest_profile (
  workspace_id uuid not null,
  user_id uuid not null,
  email_domain text not null check (email_domain = lower(email_domain) and email_domain like '%.%'),
  invited_by uuid,
  created_at timestamptz not null default now(),
  -- A hard stop: past this moment the guest is locked out of everything, with no sweeper involved.
  expires_at timestamptz not null,
  deactivated_at timestamptz,
  last_in_space_at timestamptz not null default now(),
  locked_until timestamptz,
  failed_codes integer not null default 0,
  primary key (workspace_id, user_id),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);

alter table core.guest_profile enable row level security;
alter table core.guest_profile force row level security;
grant select on core.guest_profile to legallabs_definer, legallabs_app;
grant insert, update on core.guest_profile to legallabs_definer;
create policy definer_all on core.guest_profile for all to legallabs_definer using (true) with check (true);
-- Admins see their guests' state; a guest reaches their own row only through definer functions.
create policy guest_profile_read on core.guest_profile for select to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.users'));

-- A live guest: active, not expired, not deactivated. Takes the id so a session lookup, which runs
-- before any identity is set, can ask too.
create function core.guest_live(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core."user" u
      join core.guest_profile p on p.workspace_id = u.workspace_id and p.user_id = u.id
     where u.id = p_user and u.kind = 'guest' and u.status = 'active'
       and p.deactivated_at is null and p.expires_at > now())
$$;
alter function core.guest_live(uuid) owner to legallabs_definer;
grant execute on function core.guest_live(uuid) to legallabs_app, legallabs_definer;

create function core.is_active_guest() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core."user" u
                  where u.id = core.current_user_id()
                    and u.workspace_id = core.current_workspace_id()
                    and core.guest_live(u.id))
$$;
alter function core.is_active_guest() owner to legallabs_definer;
grant execute on function core.is_active_guest() to legallabs_app, legallabs_definer;

-- THE guest fence. A guest is never an active member, so core.in_tenant() and every policy built on
-- it refuse them. Existing policies that call this function directly are covered too.
create or replace function core.is_active_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core."user" u
     where u.id = core.current_user_id()
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active'
       and u.kind <> 'guest')
$$;

-- Guests hold no permission at all, whatever a role or extra_permissions row says.
create or replace function core.has_permission(permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select (permission = any (u.extra_permissions || r.permissions) or '*' = any (r.permissions))
           and u.kind <> 'guest'
           -- Service accounts never hold admin permissions.
           and (u.kind = 'member' or permission not like 'admin.%')
      from core."user" u
      left join core.role r on r.workspace_id = u.workspace_id and r.id = u.role_id
     where u.id = core.current_user_id()
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active'), false)
$$;

-- Walls still apply to guests, and an expired guest passes none.
create or replace function core.user_can_access_matter(user_id uuid, matter_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with who as (
    select u.id, u.workspace_id, u.kind from core."user" u
     where u.id = user_can_access_matter.user_id
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active'
       and (u.kind <> 'guest' or core.guest_live(u.id))
  ), principals as (
    select 'user' as type, who.id from who
    union all
    select 'group', m.group_id from core.group_member m
      join who on m.user_id = who.id and m.workspace_id = who.workspace_id
  )
  select case
    when not exists (select 1 from who) then false
    when user_can_access_matter.matter_id is null then true
    else coalesce((
      select not exists (
               select 1 from core.wall w join principals p
                 on w.principal_type = p.type and w.principal_id = p.id
                where w.matter_id = mt.id and w.effect = 'deny')
             -- An open matter is for members; a guest needs an allow row (for them or their party).
             and ((mt.wall_mode = 'open' and who.kind = 'member') or exists (
               select 1 from core.wall w join principals p
                 on w.principal_type = p.type and w.principal_id = p.id
                where w.matter_id = mt.id and w.effect = 'allow'))
        from core.matter mt join who on mt.workspace_id = who.workspace_id
       where mt.id = user_can_access_matter.matter_id), false)
  end
$$;

-- A session for an expired or deactivated guest resolves to nothing.
create or replace function core.resolve_session(token_hash bytea)
returns table (session_id uuid, user_id uuid, workspace_id uuid, mfa_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.id, s.user_id, s.workspace_id, s.mfa_at
    from core.session s join core."user" u on u.workspace_id = s.workspace_id and u.id = s.user_id
   where s.token_hash = resolve_session.token_hash
     and s.revoked_at is null
     and s.expires_at > now()
     and u.status = 'active'
     and (u.kind <> 'guest' or core.guest_live(u.id))
$$;

-- Guests never hold API tokens.
create or replace function core.resolve_api_token(token_hash bytea)
returns table (token_id uuid, principal_id uuid, workspace_id uuid, scopes text[])
language sql stable security definer set search_path = '' as $$
  select t.id, t.principal_id, t.workspace_id, t.scopes
    from core.api_token t join core."user" u on u.workspace_id = t.workspace_id and u.id = t.principal_id
   where t.token_hash = resolve_api_token.token_hash
     and t.revoked_at is null
     and t.expires_at > now()
     and u.status = 'active'
     and u.kind <> 'guest'
$$;

grant insert, update on core."user" to legallabs_definer;
create policy definer_guest_insert on core."user" for insert to legallabs_definer
  with check (kind = 'guest');
create policy definer_guest_update on core."user" for update to legallabs_definer
  using (kind = 'guest') with check (kind = 'guest');

-- Email-code login. The app role has no grant on the table: the two functions below are the only way.
create table core.guest_login_code (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  user_id uuid not null,
  code_hash bytea not null check (octet_length(code_hash) = 32),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attempts integer not null default 0,
  consumed_at timestamptz,
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);
create index guest_login_code_user_idx on core.guest_login_code (workspace_id, user_id, created_at desc);
alter table core.guest_login_code enable row level security;
alter table core.guest_login_code force row level security;
grant select, insert, update on core.guest_login_code to legallabs_definer;
create policy definer_all on core.guest_login_code for all to legallabs_definer using (true) with check (true);

-- Issues a code for a guest who is live and has at least one Space membership. Unknown emails and
-- ineligible guests return issued = false, so the caller answers the same either way.
create function core.issue_guest_code(p_workspace_slug text, p_email text, p_code_hash bytea)
returns table (user_id uuid, workspace_id uuid, issued boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  u record;
begin
  select x.id, x.workspace_id into u
    from core."user" x join core.workspace w on w.id = x.workspace_id
   where w.slug = p_workspace_slug and lower(x.email) = lower(p_email) and x.kind = 'guest'
     and core.guest_live(x.id);
  if not found then
    return query select null::uuid, null::uuid, false;
    return;
  end if;
  if not exists (select 1 from work.space_member m
                  where m.workspace_id = u.workspace_id and m.principal_type = 'user'
                    and m.principal_id = u.id and m.role = 'guest') then
    return query select u.id, u.workspace_id, false;
    return;
  end if;
  if exists (select 1 from core.guest_profile p
              where p.workspace_id = u.workspace_id and p.user_id = u.id and p.locked_until > now())
     -- At most five codes an hour, so a mailbox cannot be flooded.
     or (select count(*) from core.guest_login_code c
          where c.workspace_id = u.workspace_id and c.user_id = u.id
            and c.created_at > now() - interval '1 hour') >= 5 then
    return query select u.id, u.workspace_id, false;
    return;
  end if;
  update core.guest_login_code c set consumed_at = now()
   where c.workspace_id = u.workspace_id and c.user_id = u.id and c.consumed_at is null;
  insert into core.guest_login_code (workspace_id, user_id, code_hash, expires_at)
  values (u.workspace_id, u.id, p_code_hash, now() + interval '10 minutes');
  return query select u.id, u.workspace_id, true;
end
$$;

-- Five wrong attempts lock the guest for 15 minutes. A right code is spent at once.
create function core.verify_guest_code(p_workspace_slug text, p_email text, p_code_hash bytea)
returns table (user_id uuid, workspace_id uuid, ok boolean, reason text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  u record;
  c record;
begin
  select x.id, x.workspace_id into u
    from core."user" x join core.workspace w on w.id = x.workspace_id
   where w.slug = p_workspace_slug and lower(x.email) = lower(p_email) and x.kind = 'guest'
     and core.guest_live(x.id);
  if not found then
    return query select null::uuid, null::uuid, false, 'invalid'::text;
    return;
  end if;
  if exists (select 1 from core.guest_profile p
              where p.workspace_id = u.workspace_id and p.user_id = u.id and p.locked_until > now()) then
    return query select u.id, u.workspace_id, false, 'locked'::text;
    return;
  end if;
  select * into c from core.guest_login_code k
   where k.workspace_id = u.workspace_id and k.user_id = u.id
     and k.consumed_at is null and k.expires_at > now()
   order by k.created_at desc limit 1
   for update;
  if not found then
    return query select u.id, u.workspace_id, false, 'invalid'::text;
    return;
  end if;
  if c.code_hash = p_code_hash then
    update core.guest_login_code set consumed_at = now() where id = c.id;
    update core.guest_profile set failed_codes = 0, locked_until = null
     where workspace_id = u.workspace_id and user_id = u.id;
    return query select u.id, u.workspace_id, true, null::text;
    return;
  end if;
  update core.guest_login_code set attempts = attempts + 1 where id = c.id;
  update core.guest_profile p set failed_codes = p.failed_codes + 1,
         locked_until = case when p.failed_codes + 1 >= 5 then now() + interval '15 minutes' end
   where p.workspace_id = u.workspace_id and p.user_id = u.id;
  if c.attempts + 1 >= 5 then
    update core.guest_login_code set consumed_at = now() where id = c.id;
  end if;
  return query select u.id, u.workspace_id, false, 'invalid'::text;
end
$$;
alter function core.issue_guest_code(text, text, bytea) owner to legallabs_definer;
alter function core.verify_guest_code(text, text, bytea) owner to legallabs_definer;
grant execute on function core.issue_guest_code(text, text, bytea),
  core.verify_guest_code(text, text, bytea) to legallabs_app;
