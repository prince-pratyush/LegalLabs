-- One wall check for anyone, so sharing can ask about the recipient, not just the caller.
create function core.user_can_access_matter(user_id uuid, matter_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with who as (
    select u.id, u.workspace_id, u.kind from core."user" u
     where u.id = user_can_access_matter.user_id
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active'
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
             and ((mt.wall_mode = 'open' and who.kind = 'member') or exists (
               select 1 from core.wall w join principals p
                 on w.principal_type = p.type and w.principal_id = p.id
                where w.matter_id = mt.id and w.effect = 'allow'))
        from core.matter mt join who on mt.workspace_id = who.workspace_id
       where mt.id = user_can_access_matter.matter_id), false)
  end
$$;
alter function core.user_can_access_matter(uuid, uuid) owner to legallabs_definer;
grant execute on function core.user_can_access_matter(uuid, uuid) to legallabs_definer;

create or replace function core.can_access_matter(matter_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select core.user_can_access_matter(core.current_user_id(), can_access_matter.matter_id)
$$;

-- Readers are the owner and anyone the thread is shared with, and each must pass its wall.
drop policy thread_read on work.thread;
create policy thread_read on work.thread for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (owner_id = core.current_user_id() or core.has_access('thread', id, 'view'))
         and core.can_access_matter(matter_id));

-- A shared thread is read-only: only its owner adds to it.
drop policy thread_document_insert on work.thread_document;
create policy thread_document_insert on work.thread_document for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and core.has_permission('threads.use')
              and exists (
                select 1 from work.thread t
                  join content.document_version v on v.id = version_id
                  join content.document d on d.id = v.document_id
                 where t.id = thread_id and t.owner_id = core.current_user_id()
                   and d.matter_id is not distinct from t.matter_id));
drop policy message_insert on work.message;
create policy message_insert on work.message for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and core.has_permission('threads.use')
              and exists (select 1 from work.thread t
                           where t.id = thread_id and t.owner_id = core.current_user_id()));
drop policy citation_insert on work.citation;
create policy citation_insert on work.citation for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and core.has_permission('threads.use')
              and exists (
                select 1 from work.message m join work.thread t on t.id = m.thread_id
                 where m.id = message_id and t.owner_id = core.current_user_id()
                   and (version_id is null or exists (
                     select 1 from work.thread_document td
                      where td.thread_id = m.thread_id and td.version_id = citation.version_id))));

-- Threads are shared only through work.share_thread, which checks ownership and walls.
drop policy share_grant_insert on core.share_grant;
create policy share_grant_insert on core.share_grant for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and granted_by = core.current_user_id()
              and object_type <> 'thread');
drop policy share_grant_delete on core.share_grant;
create policy share_grant_delete on core.share_grant for delete to legallabs_app
  using (core.in_tenant(workspace_id) and object_type <> 'thread'
         and (granted_by = core.current_user_id() or core.has_permission('admin.config')));

grant select on work.thread to legallabs_definer;
create policy definer_read on work.thread for select to legallabs_definer
  using (workspace_id = core.current_workspace_id());
grant insert, delete on core.share_grant to legallabs_definer;
create policy definer_insert on core.share_grant for insert to legallabs_definer
  with check (workspace_id = core.current_workspace_id());
create policy definer_delete on core.share_grant for delete to legallabs_definer
  using (workspace_id = core.current_workspace_id());

-- The caller's own thread, or null; walls apply to the caller too.
create function work.owned_thread(thread_id uuid) returns work.thread
language sql stable security definer set search_path = '' as $$
  select t.* from work.thread t
   where t.id = owned_thread.thread_id
     and t.workspace_id = core.current_workspace_id()
     and t.owner_id = core.current_user_id()
     and core.has_permission('threads.use')
     and core.can_access_matter(t.matter_id)
$$;
alter function work.owned_thread(uuid) owner to legallabs_definer;

/*
 * Shares a thread read-only. Each person is checked on their own, so one
 * walled recipient doesn't block the rest. A link share reaches every member,
 * so a thread behind a wall can't have one.
 */
create function work.share_thread(thread_id uuid, user_ids uuid[], link boolean)
returns table (principal_id uuid, outcome text)
language plpgsql security definer set search_path = '' as $$
-- The output columns share names with share_grant's, and here the table is meant.
#variable_conflict use_column
declare
  t work.thread;
  person uuid;
begin
  t := work.owned_thread(share_thread.thread_id);
  if t.id is null then
    raise exception 'thread not found' using errcode = 'no_data_found';
  end if;
  if link and t.matter_id is not null then
    raise exception 'WALL_MISMATCH' using errcode = 'check_violation';
  end if;
  foreach person in array coalesce(user_ids, '{}') loop
    principal_id := person;
    if person = t.owner_id then
      continue;
    elsif not exists (select 1 from core."user" u
                       where u.id = person and u.workspace_id = t.workspace_id
                         and u.status = 'active' and u.kind = 'member') then
      outcome := 'NOT_MEMBER';
    elsif not core.user_can_access_matter(person, t.matter_id) then
      outcome := 'WALL_DENIED';
    else
      insert into core.share_grant (workspace_id, object_type, object_id, principal_type,
                                    principal_id, level, granted_by)
      values (t.workspace_id, 'thread', t.id, 'user', person, 'view', t.owner_id)
      on conflict (object_type, object_id, principal_type, principal_id) do nothing;
      outcome := 'created';
    end if;
    return next;
  end loop;
  if link then
    insert into core.share_grant (workspace_id, object_type, object_id, principal_type,
                                  principal_id, level, granted_by)
    values (t.workspace_id, 'thread', t.id, 'workspace', t.workspace_id, 'view', t.owner_id)
    on conflict (object_type, object_id, principal_type, principal_id) do nothing;
    principal_id := t.workspace_id;
    outcome := 'created';
    return next;
  end if;
end
$$;
alter function work.share_thread(uuid, uuid[], boolean) owner to legallabs_definer;
grant execute on function work.share_thread(uuid, uuid[], boolean) to legallabs_app;

create function work.thread_shares(thread_id uuid)
returns table (id uuid, principal_type text, principal_id uuid, email text, granted_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select g.id, g.principal_type, g.principal_id, u.email, g.granted_at
    from core.share_grant g
    left join core."user" u on g.principal_type = 'user' and u.id = g.principal_id
   where g.object_type = 'thread'
     and g.object_id = (work.owned_thread(thread_shares.thread_id)).id
   order by g.granted_at, g.id
$$;
alter function work.thread_shares(uuid) owner to legallabs_definer;
grant execute on function work.thread_shares(uuid) to legallabs_app;

create function work.revoke_thread_share(thread_id uuid, share_id uuid) returns boolean
language sql security definer set search_path = '' as $$
  with gone as (
    delete from core.share_grant g
     where g.id = revoke_thread_share.share_id
       and g.object_type = 'thread'
       and g.object_id = (work.owned_thread(revoke_thread_share.thread_id)).id
    returning 1)
  select exists (select 1 from gone)
$$;
alter function work.revoke_thread_share(uuid, uuid) owner to legallabs_definer;
grant execute on function work.revoke_thread_share(uuid, uuid) to legallabs_app;
