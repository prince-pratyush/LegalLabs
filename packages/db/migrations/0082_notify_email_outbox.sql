-- Emails waiting to go out. Rows are written and claimed by definer functions added with the
-- email worker; the app role may only read its own.
create table notify.email_outbox (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  user_id uuid not null,
  category text not null check (char_length(category) between 1 and 40),
  batch_key text not null check (char_length(batch_key) between 1 and 200),
  payload jsonb not null,
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  error text check (char_length(error) <= 500),
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);
create index email_outbox_due_idx on notify.email_outbox (scheduled_at) where sent_at is null;
create index email_outbox_batch_idx on notify.email_outbox (batch_key);

alter table notify.email_outbox enable row level security;
alter table notify.email_outbox force row level security;
grant select on notify.email_outbox to legallabs_app;
create policy own_outbox on notify.email_outbox for select to legallabs_app
  using (user_id = core.current_user_id() and core.in_tenant(workspace_id));

grant select, insert, update, delete on notify.email_outbox to legallabs_definer;
create policy definer_all on notify.email_outbox for all to legallabs_definer
  using (true) with check (true);
