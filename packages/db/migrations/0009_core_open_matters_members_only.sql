-- Open means open to members. Guests and service accounts need an allow row on every matter.
create or replace function core.can_access_matter(matter_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with me as (
    select u.id, u.workspace_id, u.kind from core."user" u
     where u.id = core.current_user_id()
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active'
  ), principals as (
    select 'user' as type, me.id from me
    union all
    select 'group', m.group_id from core.group_member m
      join me on m.user_id = me.id and m.workspace_id = me.workspace_id
  )
  select case
    when not exists (select 1 from me) then false
    when can_access_matter.matter_id is null then true
    else coalesce((
      select not exists (
               select 1 from core.wall w join principals p
                 on w.principal_type = p.type and w.principal_id = p.id
                where w.matter_id = mt.id and w.effect = 'deny')
             and ((mt.wall_mode = 'open' and me.kind = 'member') or exists (
               select 1 from core.wall w join principals p
                 on w.principal_type = p.type and w.principal_id = p.id
                where w.matter_id = mt.id and w.effect = 'allow'))
        from core.matter mt join me on mt.workspace_id = me.workspace_id
       where mt.id = can_access_matter.matter_id), false)
  end
$$;
