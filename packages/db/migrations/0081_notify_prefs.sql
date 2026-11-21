-- Email settings: each person's choices, their quiet hours, and what the workspace sets.
create table notify.notification_pref (
  workspace_id uuid not null,
  user_id uuid not null,
  category text not null check (char_length(category) between 1 and 40),
  value boolean not null,
  mode text not null default 'action_only' check (mode in ('action_only', 'all')),
  updated_at timestamptz not null default now(),
  primary key (user_id, category),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);

create table notify.notification_quiet_hours (
  workspace_id uuid not null,
  user_id uuid primary key,
  from_local time not null,
  to_local time not null,
  tz text not null check (char_length(tz) between 1 and 64),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);

create table notify.workspace_notification_pref (
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  category text not null check (char_length(category) between 1 and 40),
  default_value boolean not null default true,
  locked boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, category)
);

-- Off: emails carry titles and links only. On: they add the start of a comment or question.
create table notify.workspace_notification_setting (
  workspace_id uuid primary key references core.workspace (id) on delete cascade,
  include_content boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table notify.notification_pref enable row level security;
alter table notify.notification_pref force row level security;
alter table notify.notification_quiet_hours enable row level security;
alter table notify.notification_quiet_hours force row level security;
alter table notify.workspace_notification_pref enable row level security;
alter table notify.workspace_notification_pref force row level security;
alter table notify.workspace_notification_setting enable row level security;
alter table notify.workspace_notification_setting force row level security;

grant select, insert, update, delete on notify.notification_pref to legallabs_app;
grant select, insert, update, delete on notify.notification_quiet_hours to legallabs_app;
create policy own_pref on notify.notification_pref for all to legallabs_app
  using (user_id = core.current_user_id() and core.in_tenant(workspace_id))
  with check (user_id = core.current_user_id() and core.in_tenant(workspace_id));
create policy own_quiet on notify.notification_quiet_hours for all to legallabs_app
  using (user_id = core.current_user_id() and core.in_tenant(workspace_id))
  with check (user_id = core.current_user_id() and core.in_tenant(workspace_id));

-- Everyone in the workspace reads the defaults; admin.config changes them.
grant select, insert, update on notify.workspace_notification_pref to legallabs_app;
grant select, insert, update on notify.workspace_notification_setting to legallabs_app;
create policy ws_pref_read on notify.workspace_notification_pref for select to legallabs_app
  using (core.in_tenant(workspace_id));
create policy ws_pref_insert on notify.workspace_notification_pref for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));
create policy ws_pref_update on notify.workspace_notification_pref for update to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.config'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));
create policy ws_setting_read on notify.workspace_notification_setting for select to legallabs_app
  using (core.in_tenant(workspace_id));
create policy ws_setting_insert on notify.workspace_notification_setting for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));
create policy ws_setting_update on notify.workspace_notification_setting for update to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.config'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));

grant select on notify.notification_pref, notify.notification_quiet_hours,
  notify.workspace_notification_pref, notify.workspace_notification_setting
  to legallabs_definer;
create policy definer_read on notify.notification_pref for select to legallabs_definer using (true);
create policy definer_read on notify.notification_quiet_hours for select to legallabs_definer using (true);
create policy definer_read on notify.workspace_notification_pref for select to legallabs_definer using (true);
create policy definer_read on notify.workspace_notification_setting for select to legallabs_definer using (true);
