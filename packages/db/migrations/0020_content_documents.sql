create schema content;
grant usage on schema content to legallabs_app;

create table content.document (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  owner_id uuid not null,
  matter_id uuid,
  name text not null check (char_length(name) between 1 and 255),
  mime text not null,
  size bigint not null check (size > 0),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id),
  foreign key (workspace_id, matter_id) references core.matter (workspace_id, id)
);
create index document_owner_idx on content.document (workspace_id, owner_id, id desc);

-- Citations pin a version, so pages and chunks hang off it even while each document has one.
create table content.document_version (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  document_id uuid not null,
  version_no integer not null default 1 check (version_no >= 1),
  sha256 bytea not null check (octet_length(sha256) = 32),
  page_count integer not null check (page_count >= 1),
  empty_page_count integer not null default 0 check (empty_page_count >= 0),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (document_id, version_no),
  foreign key (workspace_id, document_id) references content.document (workspace_id, id) on delete cascade,
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id)
);

create table content.document_blob (
  version_id uuid primary key,
  workspace_id uuid not null,
  bytes bytea not null,
  foreign key (workspace_id, version_id) references content.document_version (workspace_id, id) on delete cascade
);

create table content.page (
  version_id uuid not null,
  page_no integer not null check (page_no >= 1),
  workspace_id uuid not null,
  width real not null,
  height real not null,
  text text not null,
  layout jsonb not null,
  primary key (version_id, page_no),
  unique (workspace_id, version_id, page_no),
  foreign key (workspace_id, version_id) references content.document_version (workspace_id, id) on delete cascade
);

-- A chunk stays on one page, so a quote from it always resolves to a single page.
create table content.chunk (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  version_id uuid not null,
  page_no integer not null,
  ordinal integer not null check (ordinal >= 0),
  char_from integer not null check (char_from >= 0),
  char_to integer not null,
  text text not null,
  tsv tsvector generated always as (to_tsvector('english', text)) stored,
  check (char_to > char_from),
  unique (version_id, ordinal),
  foreign key (workspace_id, version_id, page_no)
    references content.page (workspace_id, version_id, page_no) on delete cascade
);
create index chunk_tsv_idx on content.chunk using gin (tsv);

alter table content.document enable row level security;
alter table content.document force row level security;
alter table content.document_version enable row level security;
alter table content.document_version force row level security;
alter table content.document_blob enable row level security;
alter table content.document_blob force row level security;
alter table content.page enable row level security;
alter table content.page force row level security;
alter table content.chunk enable row level security;
alter table content.chunk force row level security;

-- No update or delete: a citation must keep matching the text it was checked against.
grant select, insert on content.document, content.document_version, content.page, content.chunk
  to legallabs_app;
-- Insert only: nothing reads originals yet, so no bug can leak one.
grant insert on content.document_blob to legallabs_app;

-- The one definition of who sees a document. Everything below it defers to this row.
create policy document_read on content.document for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and owner_id = core.current_user_id()
         and core.can_access_matter(matter_id));
create policy document_insert on content.document for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and owner_id = core.current_user_id()
              and core.can_access_matter(matter_id)
              and core.has_permission('threads.use'));

create policy version_read on content.document_version for select to legallabs_app
  using (core.in_tenant(workspace_id) and exists (
    select 1 from content.document d where d.id = document_id));
create policy version_insert on content.document_version for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and created_by = core.current_user_id()
              and exists (select 1 from content.document d where d.id = document_id));

create policy blob_insert on content.document_blob for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and exists (
    select 1 from content.document_version v where v.id = version_id));

create policy page_read on content.page for select to legallabs_app
  using (core.in_tenant(workspace_id) and exists (
    select 1 from content.document_version v where v.id = version_id));
create policy page_insert on content.page for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and exists (
    select 1 from content.document_version v where v.id = version_id));

create policy chunk_read on content.chunk for select to legallabs_app
  using (core.in_tenant(workspace_id) and exists (
    select 1 from content.document_version v where v.id = version_id));
create policy chunk_insert on content.chunk for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and exists (
    select 1 from content.document_version v where v.id = version_id));
