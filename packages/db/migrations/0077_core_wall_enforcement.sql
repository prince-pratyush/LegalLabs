-- The admin's diagnostic: the same rule as core.user_can_access_matter, with its workings.
create function core.evaluate_wall(p_user uuid, p_matter uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  who core."user";
  mt core.matter;
  rules jsonb;
  denied boolean;
  allowed boolean;
begin
  if not core.has_permission('admin.matters') then
    return null;
  end if;
  select * into who from core."user" u
   where u.id = p_user and u.workspace_id = core.current_workspace_id();
  if who.id is null then
    return null;
  end if;
  if p_matter is null then
    return jsonb_build_object('allowed', true, 'reason', 'no_matter', 'matched_rules', '[]'::jsonb);
  end if;
  select * into mt from core.matter m
   where m.id = p_matter and m.workspace_id = core.current_workspace_id();
  if mt.id is null then
    return null;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', w.id, 'matter_id', w.matter_id, 'principal_type', w.principal_type,
           'principal_id', w.principal_id, 'effect', w.effect, 'provider', w.provider)
           order by w.effect desc, w.provider, w.id), '[]'::jsonb),
         coalesce(bool_or(w.effect = 'deny'), false),
         coalesce(bool_or(w.effect = 'allow'), false)
    into rules, denied, allowed
    from core.wall w
   where w.matter_id = mt.id
     and ((w.principal_type = 'user' and w.principal_id = who.id)
       or (w.principal_type = 'group' and exists (
             select 1 from core.group_member gm
              where gm.group_id = w.principal_id and gm.user_id = who.id
                and gm.workspace_id = who.workspace_id)));
  if who.status <> 'active' or denied then
    return jsonb_build_object('allowed', false, 'reason', 'deny', 'matched_rules', rules);
  end if;
  if mt.wall_mode = 'allow_list' or who.kind <> 'member' then
    return jsonb_build_object('allowed', allowed,
                              'reason', case when allowed then 'allowed' else 'not_allow_listed' end,
                              'matched_rules', rules);
  end if;
  return jsonb_build_object('allowed', true, 'reason', 'open', 'matched_rules', rules);
end
$$;
alter function core.evaluate_wall(uuid, uuid) owner to legallabs_definer;
grant execute on function core.evaluate_wall(uuid, uuid) to legallabs_app;

-- Active people a grant reaches; suspended accounts can't read anything anyway.
create function core.grant_recipients(p_type text, p_id uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select u.id from core."user" u
   where u.workspace_id = core.current_workspace_id() and u.status = 'active'
     and ((p_type = 'user' and u.id = p_id)
       or (p_type = 'group' and exists (
             select 1 from core.group_member m
              where m.group_id = p_id and m.user_id = u.id and m.workspace_id = u.workspace_id))
       or (p_type = 'workspace' and p_id = u.workspace_id and u.kind = 'member'))
$$;
alter function core.grant_recipients(text, uuid) owner to legallabs_definer;

/*
 * How many people a proposed share would reach who are walled from the matter, counted only
 * when the matter requires walls for sharing. Callers must reach the matter themselves.
 */
create function core.wall_share_blocked(p_matter uuid, p_principals jsonb) returns integer
language sql stable security definer set search_path = '' as $$
  select case
    when p_matter is null or not core.can_access_matter(p_matter) then 0
    when not coalesce((select m.require_walls_for_sharing from core.matter m
                        where m.id = p_matter
                          and m.workspace_id = core.current_workspace_id()), false) then 0
    else (select count(distinct r)::integer
            from jsonb_array_elements(coalesce(p_principals, '[]')) p,
                 lateral core.grant_recipients(p ->> 'principal_type',
                                               (p ->> 'principal_id')::uuid) r
           where not core.user_can_access_matter(r, p_matter))
  end
$$;
alter function core.wall_share_blocked(uuid, jsonb) owner to legallabs_definer;
grant execute on function core.wall_share_blocked(uuid, jsonb) to legallabs_app;

grant update (suspended_reason) on core.share_grant to legallabs_definer;
create policy definer_suspend on core.share_grant for update to legallabs_definer
  using (workspace_id = core.current_workspace_id())
  with check (workspace_id = core.current_workspace_id());

/*
 * Suspends grants on matter objects that now reach a walled person, and reinstates ones that
 * no longer do. Only matters that require walls for sharing are held to this. Run in the
 * caller's workspace, or with none set (a sync or the schema owner), in the grant's own.
 */
create function core.revalidate_wall_grants(p_workspace uuid, p_matter uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  prior text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  r record;
  compliant boolean;
  changed integer := 0;
begin
  if prior = '' then
    perform pg_catalog.set_config('app.workspace_id', p_workspace::text, true);
  elsif prior <> p_workspace::text then
    return 0;
  end if;
  for r in
    select g.id, g.object_type, g.object_id, g.principal_type, g.principal_id,
           g.suspended_reason, m.id as matter_id, m.require_walls_for_sharing as required
      from core.share_grant g
      join lateral (
        select t.matter_id from work.thread t
         where g.object_type = 'thread' and t.id = g.object_id
        union all
        select v.matter_id from content.vault v
         where g.object_type = 'vault' and v.id = g.object_id
        union all
        select d.matter_id from content.document d
         where g.object_type = 'document' and d.id = g.object_id) o on true
      join core.matter m on m.id = o.matter_id
     where g.workspace_id = p_workspace
       and (p_matter is null or m.id = p_matter)
       and (g.suspended_reason is null or g.suspended_reason = 'wall')
     order by g.id
  loop
    compliant := not r.required or not exists (
      select 1 from core.grant_recipients(r.principal_type, r.principal_id) person
       where not core.user_can_access_matter(person, r.matter_id));
    continue when compliant = (r.suspended_reason is null);
    update core.share_grant set suspended_reason = case when compliant then null else 'wall' end
     where id = r.id;
    perform admin.append_audit_event(
      case when compliant then 'wall.share_reinstated' else 'wall.share_suspended' end,
      case when core.current_user_id() is null then 'system' else 'user' end,
      core.current_user_id(), r.object_type, r.object_id::text,
      jsonb_build_object('grant_id', r.id, 'matter_id', r.matter_id,
                         'principal_type', r.principal_type, 'principal_id', r.principal_id));
    changed := changed + 1;
  end loop;
  if prior = '' then
    perform pg_catalog.set_config('app.workspace_id', '', true);
  end if;
  return changed;
end
$$;
alter function core.revalidate_wall_grants(uuid, uuid) owner to legallabs_definer;

-- Walls, groups and the matter's own switches all move who a grant reaches.
create function core.walls_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  for r in select distinct workspace_id, matter_id from changed loop
    perform core.revalidate_wall_grants(r.workspace_id, r.matter_id);
  end loop;
  return null;
end
$$;
alter function core.walls_changed() owner to legallabs_definer;
create trigger wall_inserted after insert on core.wall
  referencing new table as changed for each statement execute function core.walls_changed();
create trigger wall_deleted after delete on core.wall
  referencing old table as changed for each statement execute function core.walls_changed();
create trigger wall_updated after update on core.wall
  referencing new table as changed for each statement execute function core.walls_changed();

create function core.group_members_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
begin
  for ws in select distinct workspace_id from changed loop
    perform core.revalidate_wall_grants(ws, null);
  end loop;
  return null;
end
$$;
alter function core.group_members_changed() owner to legallabs_definer;
create trigger group_member_added after insert on core.group_member
  referencing new table as changed for each statement
  execute function core.group_members_changed();
create trigger group_member_removed after delete on core.group_member
  referencing old table as changed for each statement
  execute function core.group_members_changed();

create function core.matter_walls_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform core.revalidate_wall_grants(new.workspace_id, new.id);
  return null;
end
$$;
alter function core.matter_walls_changed() owner to legallabs_definer;
create trigger matter_walls_changed
  after update of require_walls_for_sharing, wall_mode on core.matter
  for each row
  when (old.require_walls_for_sharing is distinct from new.require_walls_for_sharing
        or old.wall_mode is distinct from new.wall_mode)
  execute function core.matter_walls_changed();

-- Group shares for threads, checked one group at a time like user shares.
create function work.share_thread_groups(thread_id uuid, group_ids uuid[])
returns table (principal_id uuid, outcome text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  t work.thread;
  grp uuid;
begin
  t := work.owned_thread(share_thread_groups.thread_id);
  if t.id is null then
    raise exception 'thread not found' using errcode = 'no_data_found';
  end if;
  foreach grp in array coalesce(group_ids, '{}') loop
    principal_id := grp;
    -- Party groups hold guests, who reach threads only through a Space.
    if not exists (select 1 from core."group" g
                    where g.id = grp and g.workspace_id = t.workspace_id and g.kind = 'standard') then
      outcome := 'NOT_MEMBER';
    else
      insert into core.share_grant (workspace_id, object_type, object_id, principal_type,
                                    principal_id, level, granted_by)
      values (t.workspace_id, 'thread', t.id, 'group', grp, 'view', t.owner_id)
      on conflict (object_type, object_id, principal_type, principal_id) do nothing;
      outcome := 'created';
    end if;
    return next;
  end loop;
end
$$;
alter function work.share_thread_groups(uuid, uuid[]) owner to legallabs_definer;
grant execute on function work.share_thread_groups(uuid, uuid[]) to legallabs_app;
