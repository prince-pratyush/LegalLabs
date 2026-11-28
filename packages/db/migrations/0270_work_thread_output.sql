-- Files a thread made. The bytes live in the row, so a purged or held thread takes or keeps them
-- with it, and nothing is left in object storage.

-- The documents whose text was given to the model for this answer, cited or not. A later file made
-- from the conversation may repeat any of them.
alter table work.message
  add column read_documents uuid[] not null default '{}'
    check (cardinality(read_documents) <= 12000);

create table work.thread_output (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  thread_id uuid not null,
  message_id uuid not null,
  owner_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  format text not null check (format in ('docx', 'xlsx')),
  size integer not null check (size between 1 and 5242880),
  source_documents uuid[] not null default '{}' check (cardinality(source_documents) <= 12000),
  bytes bytea not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (octet_length(bytes) = size),
  foreign key (workspace_id, thread_id) references work.thread (workspace_id, id) on delete cascade,
  foreign key (workspace_id, message_id) references work.message (workspace_id, id) on delete cascade,
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id)
);
create index thread_output_thread_idx on work.thread_output (thread_id, id);

alter table work.thread_output enable row level security;
alter table work.thread_output force row level security;

grant select, insert on work.thread_output to legallabs_app;

-- The owner's alone, and only while they can see the thread: a shared reader gets no file.
create policy thread_output_read on work.thread_output for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and owner_id = core.current_user_id()
         and exists (select 1 from work.thread t where t.id = thread_id));
-- Restrictive: a file made from documents is seen only by someone who can open every one now.
create policy thread_output_sources on work.thread_output as restrictive for select to legallabs_app
  using (case when source_documents = '{}' then true
              else (select count(*) from content.document d where d.id = any (source_documents))
                   = cardinality(source_documents) end);
create policy thread_output_insert on work.thread_output for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and owner_id = core.current_user_id()
              and core.has_permission('threads.use')
              and exists (select 1 from work.thread t
                           where t.id = thread_id and t.owner_id = core.current_user_id())
              and exists (select 1 from work.message m
                           where m.id = message_id and m.thread_id = thread_output.thread_id));
