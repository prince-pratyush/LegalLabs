-- One row per workspace; a workspace without a row uses the defaults below.
create table core.matter_options (
  workspace_id uuid primary key references core.workspace (id) on delete cascade,
  require_for_queries boolean not null default false,
  user_editable boolean not null default false,
  vault_association text not null default 'optional'
    check (vault_association in ('disabled', 'optional', 'required')),
  display_format jsonb not null default
    '{"separator": "-", "show_client_id": true, "show_client_name": false, "show_description": false}',
  id_regex text check (char_length(id_regex) <= 200),
  sharing_warning text check (char_length(sharing_warning) <= 200),
  allow_matter_mismatch_in_spaces boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table core.matter_options enable row level security;
alter table core.matter_options force row level security;
grant select, insert, update on core.matter_options to legallabs_app;
grant select on core.matter_options to legallabs_definer;
create policy definer_read on core.matter_options for select to legallabs_definer using (true);
-- Every member reads them, since threads and vaults follow them.
create policy matter_options_read on core.matter_options for select to legallabs_app
  using (core.in_tenant(workspace_id));
create policy matter_options_insert on core.matter_options for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));
create policy matter_options_update on core.matter_options for update to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.config'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));

alter table core.matter add column created_by uuid;
alter table core.matter add column model_policy jsonb
  check (model_policy is null or jsonb_typeof(model_policy) = 'object');
alter table core.matter add foreign key (workspace_id, created_by)
  references core."user" (workspace_id, id);
create index matter_picker_idx on core.matter (workspace_id, status, allow_in_queries);
create index wall_matter_effect_idx on core.wall (matter_id, effect);
alter table core.wall add column created_by uuid;

create function core.matters_user_editable() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select o.user_editable from core.matter_options o
                    where o.workspace_id = core.current_workspace_id()), false)
$$;
alter function core.matters_user_editable() owner to legallabs_definer;
grant execute on function core.matters_user_editable() to legallabs_app;

-- With user_editable on, members create manual matters and edit only their own.
create policy matter_own_insert on core.matter for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and core.matters_user_editable()
              and created_by = core.current_user_id() and source = 'manual');
create policy matter_own_update on core.matter for update to legallabs_app
  using (core.in_tenant(workspace_id) and core.matters_user_editable()
         and created_by = core.current_user_id() and core.can_access_matter(id))
  with check (core.in_tenant(workspace_id) and created_by = core.current_user_id());

-- Admins see who has acknowledged a notice.
drop policy acknowledgement_read on core.matter_acknowledgement;
create policy acknowledgement_read on core.matter_acknowledgement for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and (user_id = core.current_user_id() or core.has_permission('admin.matters')));

-- The matter someone is working in, so other clients of the same session can preselect it.
alter table core.session add column current_matter_id uuid;
alter table core.session add foreign key (workspace_id, current_matter_id)
  references core.matter (workspace_id, id);
grant update (current_matter_id) on core.session to legallabs_app;
