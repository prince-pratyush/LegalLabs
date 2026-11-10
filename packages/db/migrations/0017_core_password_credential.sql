-- Apart from core."user" because every member of a workspace can read that table.
create table core.password_credential (
  workspace_id uuid not null,
  user_id uuid not null,
  password_hash text not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);

-- The app role gets no grant at all: the function below is its only way in.
grant select on core.password_credential to legallabs_definer;
alter table core.password_credential enable row level security;
alter table core.password_credential force row level security;
create policy definer_read on core.password_credential for select to legallabs_definer using (true);

-- Returns the workspace even for an unknown email, so a failed login can still be audited.
create function core.find_login_credential(workspace_slug text, email text)
returns table (workspace_id uuid, user_id uuid, status text, password_hash text)
language sql stable security definer set search_path = '' as $$
  select w.id, u.id, u.status, c.password_hash
    from core.workspace w
    left join core."user" u
      on u.workspace_id = w.id
     and lower(u.email) = lower(find_login_credential.email)
     and u.kind = 'member'
    left join core.password_credential c
      on c.workspace_id = u.workspace_id and c.user_id = u.id
   where w.slug = find_login_credential.workspace_slug
$$;
alter function core.find_login_credential(text, text) owner to legallabs_definer;
grant execute on function core.find_login_credential(text, text) to legallabs_app;
