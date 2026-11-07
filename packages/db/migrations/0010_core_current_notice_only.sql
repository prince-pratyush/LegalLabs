-- An acknowledgement counts only for the notice the person was actually shown.
drop policy acknowledgement_insert on core.matter_acknowledgement;
create policy acknowledgement_insert on core.matter_acknowledgement for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and user_id = core.current_user_id()
              and core.can_access_matter(matter_id)
              and notice_version = (select m.notice_version from core.matter m
                                     where m.id = matter_acknowledgement.matter_id));
