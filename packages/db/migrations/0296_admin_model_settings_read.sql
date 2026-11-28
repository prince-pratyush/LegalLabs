-- The model gateway reads a workspace's model settings on every call, including calls no person
-- is behind (intake classification), which row-level security would answer with nothing. One
-- function returns them whole; null means there is no such workspace, and the gateway refuses.
grant select on admin.model_config, admin.model_policy to legallabs_definer;
create policy model_definer on admin.model_config for select to legallabs_definer using (true);
create policy model_policy_definer on admin.model_policy for select to legallabs_definer using (true);

create function admin.model_settings(p_workspace uuid, p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'policy', (
      select jsonb_build_object('zdr_only', p.zdr_only, 'region_only', p.region_only,
                                'selector_disabled_roles', p.selector_disabled_roles)
        from admin.model_policy p where p.workspace_id = w.id),
    'models', coalesce((
      select jsonb_agg(to_jsonb(m) - 'workspace_id' - 'updated_at' order by m.provider, m.model)
        from admin.model_config m where m.workspace_id = w.id), '[]'::jsonb),
    'role_id', (
      select u.role_id from core."user" u where u.workspace_id = w.id and u.id = p_user))
    from core.workspace w where w.id = p_workspace
$$;
alter function admin.model_settings(uuid, uuid) owner to legallabs_definer;
revoke execute on function admin.model_settings(uuid, uuid) from public;
grant execute on function admin.model_settings(uuid, uuid) to legallabs_worker;
