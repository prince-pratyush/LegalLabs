-- Public law, shared by every workspace. Tenants only read it; the loader role writes it.
create schema knowledge;
grant usage on schema knowledge to legallabs_app;

do $$
begin
  if not exists (select from pg_roles where rolname = 'legallabs_knowledge') then
    create role legallabs_knowledge nologin;
  end if;
end
$$;
-- Not granted to the API's login: a compromised request handler must not be able to
-- rewrite the law every workspace trusts. The sync command logs in as a member of this role.
do $$
begin
  if not exists (select from pg_roles where rolname = 'legallabs_loader') then
    create role legallabs_loader nologin noinherit;
  end if;
end
$$;
grant legallabs_knowledge to legallabs_loader;
grant usage on schema knowledge to legallabs_knowledge;
-- Ids come from core.uuid7, and vectors need pgvector's casts, which live in public.
grant usage on schema core to legallabs_knowledge;
grant execute on function core.uuid7() to legallabs_knowledge;
grant execute on all functions in schema public to legallabs_knowledge;

create table knowledge.authority (
  id uuid primary key default core.uuid7(),
  -- source:scheme:external id, stable across reloads, so links and citations never move.
  ref text not null unique check (ref ~ '^[a-z][a-z0-9_]{0,39}:[a-z][a-z0-9_]{0,19}:[^\s:]{1,200}$'),
  source text not null check (source = split_part(ref, ':', 1)),
  title text not null check (char_length(title) between 1 and 1000),
  court text check (char_length(court) <= 200),
  jurisdiction text check (char_length(jurisdiction) <= 50),
  doc_type text check (char_length(doc_type) <= 50),
  decided_on date,
  url text check (url ~ '^https://' and char_length(url) <= 2000),
  citation_strings text[] not null default '{}' check (cardinality(citation_strings) <= 100),
  first_page integer check (first_page >= 1),
  last_page integer check (last_page >= first_page),
  sections text[] not null default '{}' check (cardinality(sections) <= 5000),
  meta jsonb not null default '{}' check (jsonb_typeof(meta) = 'object' and pg_column_size(meta) <= 65536),
  -- An unchanged upstream document is skipped on the next sync.
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);
create index authority_filter_idx on knowledge.authority (source, decided_on);
create index authority_court_idx on knowledge.authority (source, court);

create table knowledge.authority_chunk (
  id uuid primary key default core.uuid7(),
  authority_id uuid not null references knowledge.authority (id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  section_path text check (char_length(section_path) <= 500),
  text text not null check (char_length(text) between 1 and 20000),
  tsv tsvector generated always as (to_tsvector('english', text)) stored,
  embedding vector(1024),
  embedding_model text check (char_length(embedding_model) <= 200),
  unique (authority_id, ordinal),
  check ((embedding is null) = (embedding_model is null))
);
create index authority_chunk_tsv_idx on knowledge.authority_chunk using gin (tsv);
create index authority_chunk_embedding_idx on knowledge.authority_chunk
  using hnsw (embedding vector_cosine_ops);

-- Normalised citation string to authority. The verifier reads only this, never a model.
create table knowledge.citation_index (
  normalized text not null check (char_length(normalized) between 1 and 500),
  authority_id uuid not null references knowledge.authority (id) on delete cascade,
  kind text not null check (kind in
    ('reporter', 'parallel', 'neutral', 'docket', 'celex', 'ecli', 'act', 'alias', 'accession')),
  primary key (normalized, authority_id)
);
create index citation_index_authority_idx on knowledge.citation_index (authority_id);

create table knowledge.source_state (
  source text primary key check (source ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- The last run's counts and failures until a source syncs by delta and needs a real cursor.
  -- It holds upstream error text, so no endpoint returns it.
  cursor jsonb not null default '{}',
  doc_count bigint not null default 0 check (doc_count >= 0),
  last_refresh_at timestamptz,
  health text not null default 'ok' check (health in ('ok', 'degraded', 'down'))
);

-- Shared tables carry this mark, so the tenancy tests know they hold no workspace data.
comment on table knowledge.authority is 'legallabs:shared';
comment on table knowledge.authority_chunk is 'legallabs:shared';
comment on table knowledge.citation_index is 'legallabs:shared';
comment on table knowledge.source_state is 'legallabs:shared';

alter table knowledge.authority enable row level security;
alter table knowledge.authority force row level security;
alter table knowledge.authority_chunk enable row level security;
alter table knowledge.authority_chunk force row level security;
alter table knowledge.citation_index enable row level security;
alter table knowledge.citation_index force row level security;
alter table knowledge.source_state enable row level security;
alter table knowledge.source_state force row level security;

-- Wrapped in a select, so it is checked once per query and indexes stay usable.
create policy authority_read on knowledge.authority for select to legallabs_app
  using ((select core.is_active_member()));
create policy authority_chunk_read on knowledge.authority_chunk for select to legallabs_app
  using ((select core.is_active_member()));
create policy citation_index_read on knowledge.citation_index for select to legallabs_app
  using ((select core.is_active_member()));
create policy source_state_read on knowledge.source_state for select to legallabs_app
  using ((select core.is_active_member()));

create policy authority_load on knowledge.authority to legallabs_knowledge
  using (true) with check (true);
create policy authority_chunk_load on knowledge.authority_chunk to legallabs_knowledge
  using (true) with check (true);
create policy citation_index_load on knowledge.citation_index to legallabs_knowledge
  using (true) with check (true);
create policy source_state_load on knowledge.source_state to legallabs_knowledge
  using (true) with check (true);

grant select on knowledge.authority, knowledge.authority_chunk, knowledge.citation_index,
  knowledge.source_state to legallabs_app;
grant select, insert, update, delete on knowledge.authority, knowledge.authority_chunk,
  knowledge.citation_index, knowledge.source_state to legallabs_knowledge;

-- Saved filters are a person's own, within their workspace.
create table knowledge.source_filter_preset (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  user_id uuid not null,
  source_id text not null check (source_id ~ '^[a-z][a-z0-9_]{0,39}$'),
  name text not null check (char_length(name) between 1 and 80),
  filter jsonb not null check (jsonb_typeof(filter) = 'object' and pg_column_size(filter) <= 8192),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id, source_id, name),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);
create unique index source_filter_preset_default_idx
  on knowledge.source_filter_preset (workspace_id, user_id, source_id) where is_default;

alter table knowledge.source_filter_preset enable row level security;
alter table knowledge.source_filter_preset force row level security;
create policy source_filter_preset_own on knowledge.source_filter_preset to legallabs_app
  using (core.in_tenant(workspace_id) and user_id = core.current_user_id())
  with check (core.in_tenant(workspace_id) and user_id = core.current_user_id());
grant select, insert, update, delete on knowledge.source_filter_preset to legallabs_app;
