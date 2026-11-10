create schema work;
grant usage on schema work to legallabs_app;

create table work.thread (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  owner_id uuid not null,
  matter_id uuid,
  title text not null check (char_length(title) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id),
  foreign key (workspace_id, matter_id) references core.matter (workspace_id, id)
);
create index thread_owner_idx on work.thread (workspace_id, owner_id, id desc);

-- A version, not a document, so a citation keeps pointing at the text it was checked against.
create table work.thread_document (
  thread_id uuid not null,
  version_id uuid not null,
  workspace_id uuid not null,
  primary key (thread_id, version_id),
  foreign key (workspace_id, thread_id) references work.thread (workspace_id, id) on delete cascade,
  foreign key (workspace_id, version_id) references content.document_version (workspace_id, id)
    on delete cascade
);

create table work.message (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  thread_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) <= 100000),
  model text,
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  tokens_estimated boolean,
  cost_usd numeric(12, 6) check (cost_usd >= 0),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, thread_id) references work.thread (workspace_id, id) on delete cascade
);
create index message_thread_idx on work.message (thread_id, id);

-- The verifier's result is stored, so a reader sees what was checked rather than a fresh guess.
create table work.citation (
  message_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  workspace_id uuid not null,
  anchor integer not null check (anchor >= 0),
  version_id uuid,
  page_no integer check (page_no >= 1),
  quote text check (char_length(quote) <= 4000),
  char_from integer check (char_from >= 0),
  char_to integer,
  status text not null check (status in ('ok', 'mismatch', 'unresolved')),
  primary key (message_id, ordinal),
  check (char_to > char_from),
  check (status <> 'ok' or (version_id is not null and page_no is not null
                            and quote is not null and char_from is not null)),
  foreign key (workspace_id, message_id) references work.message (workspace_id, id) on delete cascade,
  foreign key (workspace_id, version_id) references content.document_version (workspace_id, id)
    on delete cascade
);

alter table work.thread enable row level security;
alter table work.thread force row level security;
alter table work.thread_document enable row level security;
alter table work.thread_document force row level security;
alter table work.message enable row level security;
alter table work.message force row level security;
alter table work.citation enable row level security;
alter table work.citation force row level security;

-- No update or delete: an answer stays as it was given, with the checks it had.
grant select, insert on work.thread, work.thread_document, work.message, work.citation
  to legallabs_app;

-- The one definition of who sees a thread. Everything below it defers to this row.
create policy thread_read on work.thread for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and owner_id = core.current_user_id()
         and core.can_access_matter(matter_id));
create policy thread_insert on work.thread for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and owner_id = core.current_user_id()
              and core.can_access_matter(matter_id)
              and core.has_permission('threads.use'));

create policy thread_document_read on work.thread_document for select to legallabs_app
  using (core.in_tenant(workspace_id) and exists (
    select 1 from work.thread t where t.id = thread_id));
-- Same matter only, so a thread sits behind exactly its documents' wall.
create policy thread_document_insert on work.thread_document for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and core.has_permission('threads.use')
              and exists (
                select 1 from work.thread t
                  join content.document_version v on v.id = version_id
                  join content.document d on d.id = v.document_id
                 where t.id = thread_id and d.matter_id is not distinct from t.matter_id));

create policy message_read on work.message for select to legallabs_app
  using (core.in_tenant(workspace_id) and exists (
    select 1 from work.thread t where t.id = thread_id));
create policy message_insert on work.message for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and core.has_permission('threads.use')
              and exists (select 1 from work.thread t where t.id = thread_id));

create policy citation_read on work.citation for select to legallabs_app
  using (core.in_tenant(workspace_id) and exists (
    select 1 from work.message m where m.id = message_id));
-- A citation may only point at a document its thread holds.
create policy citation_insert on work.citation for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and core.has_permission('threads.use')
              and exists (
                select 1 from work.message m
                 where m.id = message_id
                   and (version_id is null or exists (
                     select 1 from work.thread_document td
                      where td.thread_id = m.thread_id and td.version_id = citation.version_id))));
