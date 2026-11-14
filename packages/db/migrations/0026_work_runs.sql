-- A run is one turn's work; its events are what the browser replays after a reconnect.
create table work.run (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  thread_id uuid not null,
  owner_id uuid not null,
  kind text not null check (kind in ('thread', 'deep_analysis')),
  status text not null check (status in ('planned', 'awaiting_approval', 'running',
    'awaiting_input', 'verifying', 'done', 'failed', 'cancelled')),
  question_id uuid not null,
  answer_id uuid,
  plan jsonb,
  coverage jsonb,
  model text,
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, thread_id) references work.thread (workspace_id, id) on delete cascade,
  foreign key (workspace_id, question_id) references work.message (workspace_id, id),
  foreign key (workspace_id, answer_id) references work.message (workspace_id, id)
);
create index run_thread_idx on work.run (thread_id, id);

create table work.run_event (
  run_id uuid not null,
  seq integer not null check (seq >= 1),
  workspace_id uuid not null,
  type text not null check (char_length(type) <= 32),
  data jsonb not null,
  at timestamptz not null default now(),
  primary key (run_id, seq),
  foreign key (workspace_id, run_id) references work.run (workspace_id, id) on delete cascade
);

-- What a thread may read beyond its own files; sources are named by the knowledge registry.
alter table work.thread
  add column vault_ids uuid[] not null default '{}' check (cardinality(vault_ids) <= 2),
  add column sources jsonb not null default '[]' check (jsonb_typeof(sources) = 'array'
                                                        and jsonb_array_length(sources) <= 5),
  add column last_activity_at timestamptz not null default now();
create index thread_activity_idx on work.thread (workspace_id, owner_id, last_activity_at desc);

alter table work.message
  add column blocks jsonb check (blocks is null or jsonb_typeof(blocks) = 'array'),
  add column response_mode text check (response_mode in ('auto', 'edit', 'answer')),
  add column requested_model text,
  add column fallback boolean not null default false,
  -- Sentences with no verified source, as [from, to) offsets into content.
  add column ungrounded jsonb not null default '[]' check (jsonb_typeof(ungrounded) = 'array');

-- Authority citations point at a public-law source, not a document version.
alter table work.citation
  add column kind text not null default 'document' check (kind in ('document', 'authority')),
  add column authority_id text check (char_length(authority_id) <= 200),
  add column authority_citation text check (char_length(authority_citation) <= 500),
  add column authority_title text check (char_length(authority_title) <= 500),
  add column authority_url text check (char_length(authority_url) <= 2000),
  drop constraint citation_check1,
  add constraint citation_ok_located check (status <> 'ok'
    or (kind = 'document' and version_id is not null and page_no is not null
        and quote is not null and char_from is not null and char_to is not null)
    or (kind = 'authority' and authority_id is not null and quote is not null));

create table work.thread_favourite (
  thread_id uuid not null,
  user_id uuid not null,
  workspace_id uuid not null,
  primary key (thread_id, user_id),
  foreign key (workspace_id, thread_id) references work.thread (workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);

alter table work.run enable row level security;
alter table work.run force row level security;
alter table work.run_event enable row level security;
alter table work.run_event force row level security;
alter table work.thread_favourite enable row level security;
alter table work.thread_favourite force row level security;

grant select, insert on work.run, work.run_event to legallabs_app;
grant update (status, answer_id, plan, coverage, model, cost_usd, updated_at) on work.run
  to legallabs_app;
grant update (title, vault_ids, sources, last_activity_at) on work.thread to legallabs_app;
grant select, insert, delete on work.thread_favourite to legallabs_app;

-- Runs are seen by whoever sees the thread, and driven only by its owner.
create policy run_read on work.run for select to legallabs_app
  using (core.in_tenant(workspace_id) and exists (
    select 1 from work.thread t where t.id = thread_id));
create policy run_insert on work.run for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and owner_id = core.current_user_id()
              and core.has_permission('threads.use')
              and exists (select 1 from work.thread t
                           where t.id = thread_id and t.owner_id = core.current_user_id()));
create policy run_update on work.run for update to legallabs_app
  using (core.in_tenant(workspace_id) and owner_id = core.current_user_id())
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id());

create policy run_event_read on work.run_event for select to legallabs_app
  using (core.in_tenant(workspace_id) and exists (select 1 from work.run r where r.id = run_id));
create policy run_event_insert on work.run_event for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and exists (
    select 1 from work.run r where r.id = run_id and r.owner_id = core.current_user_id()));

create policy thread_update on work.thread for update to legallabs_app
  using (core.in_tenant(workspace_id) and owner_id = core.current_user_id()
         and core.can_access_matter(matter_id))
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id());

create policy favourite_own on work.thread_favourite for all to legallabs_app
  using (core.in_tenant(workspace_id) and user_id = core.current_user_id())
  with check (core.in_tenant(workspace_id) and user_id = core.current_user_id()
              and exists (select 1 from work.thread t where t.id = thread_id));
