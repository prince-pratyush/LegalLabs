-- A Library manager reviews what is waiting for approval and what is published; a draft or a
-- shared template stays between its owner and the people it is shared with.
drop policy rt_template_read on work.rt_template;
create policy rt_template_read on work.rt_template for select to legallabs_app
  using (core.in_tenant(workspace_id) and library.is_member()
         and (owner_id = core.current_user_id()
              or core.has_access('template', id, 'view')
              or (core.has_permission('library.manage')
                  and status in ('pending_approval', 'published'))
              or status = 'published'));

drop policy rt_template_update on work.rt_template;
create policy rt_template_update on work.rt_template for update to legallabs_app
  using (core.in_tenant(workspace_id) and library.is_member()
         and (owner_id = core.current_user_id()
              or core.has_access('template', id, 'edit')
              or (core.has_permission('library.manage')
                  and status in ('pending_approval', 'published'))))
  with check (core.in_tenant(workspace_id));

/*
 * The lifecycle step, as before, with three changes: a manager acts only on templates waiting
 * for approval or published; a template goes back to draft when its content changes; and it
 * can be shared only once it has been tried out.
 */
create or replace function work.rt_template_set_status(
  p_id uuid, p_status text, p_note text default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  me uuid := core.current_user_id();
  t work.rt_template;
  manager boolean := core.has_permission('library.manage');
  editor boolean;
begin
  select * into t from work.rt_template x
   where x.id = p_id and x.workspace_id = ws and x.deleted_at is null;
  manager := manager and found and t.status in ('pending_approval', 'published');
  if not found or not core.in_tenant(ws) or not library.is_member()
     or not (t.owner_id = me or core.has_access('template', t.id, 'view') or manager
             or t.status = 'published') then
    raise exception 'NOT_FOUND' using errcode = 'no_data_found';
  end if;
  editor := t.owner_id = me or core.has_access('template', t.id, 'edit');
  if p_status in ('published', 'rejected') then
    if not manager then
      raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
    end if;
    if t.status <> 'pending_approval' then
      raise exception 'BAD_TRANSITION' using errcode = 'check_violation';
    end if;
  elsif p_status = 'tested' then
    if not editor then
      raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
    end if;
    if t.status not in ('draft', 'tested', 'shared', 'rejected') then
      raise exception 'BAD_TRANSITION' using errcode = 'check_violation';
    end if;
  elsif p_status = 'shared' then
    if not editor then
      raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
    end if;
    if t.status not in ('tested', 'shared') then
      raise exception 'BAD_TRANSITION' using errcode = 'check_violation';
    end if;
  elsif p_status = 'draft' then
    if not editor then
      raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
    end if;
    if t.status not in ('tested', 'shared', 'rejected', 'draft') then
      raise exception 'BAD_TRANSITION' using errcode = 'check_violation';
    end if;
  elsif p_status = 'pending_approval' then
    if not editor then
      raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
    end if;
    if t.status not in ('tested', 'shared') then
      raise exception 'BAD_TRANSITION' using errcode = 'check_violation';
    end if;
  else
    raise exception 'BAD_TRANSITION' using errcode = 'check_violation';
  end if;

  update work.rt_template x
     set status = p_status, updated_at = now(),
         approved_by = case when p_status = 'published' then me else x.approved_by end,
         approved_at = case when p_status = 'published' then now() else x.approved_at end,
         rejected_note = case when p_status = 'rejected' then left(p_note, 1000) else null end
   where x.id = p_id;
  if p_status = 'published' and t.parent_id is not null then
    update work.rt_template x set status = 'superseded', updated_at = now()
     where x.id = t.parent_id and x.status = 'published';
  end if;
  return p_status;
end
$$;
