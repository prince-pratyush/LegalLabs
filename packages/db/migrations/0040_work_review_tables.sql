-- A review table runs typed prompts (columns) over documents (rows) from one source.
create table work.review_table (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  owner_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  source_kind text not null check (source_kind in ('vault', 'uploads')),
  vault_id uuid,
  folder_ids uuid[] check (cardinality(folder_ids) between 1 and 100),
  thread_id uuid,
  matter_id uuid,
  instructions text not null default '' check (char_length(instructions) <= 4000),
  settings jsonb not null default '{}' check (jsonb_typeof(settings) = 'object'),
  stats jsonb not null default '{}' check (jsonb_typeof(stats) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (workspace_id, id),
  -- One source, fixed at creation: a vault table names its vault, an uploads table none.
  check ((source_kind = 'vault') = (vault_id is not null)),
  check (folder_ids is null or vault_id is not null),
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id),
  foreign key (workspace_id, vault_id) references content.vault (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, thread_id) references work.thread (workspace_id, id)
    on delete set null (thread_id),
  foreign key (workspace_id, matter_id) references core.matter (workspace_id, id)
);
create index review_table_owner_idx on work.review_table (workspace_id, owner_id, updated_at desc)
  where deleted_at is null;

create table work.rt_column (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  table_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  label text not null check (char_length(label) between 1 and 80),
  type text not null
    check (type in ('date', 'currency', 'number', 'verbatim', 'free', 'classify', 'manual')),
  prompt text not null check (char_length(prompt) <= 4000),
  language text check (char_length(language) <= 35),
  model text check (char_length(model) <= 200),
  context_document_id uuid,
  options jsonb not null default '{}' check (jsonb_typeof(options) = 'object'),
  state text not null default 'pending'
    check (state in ('pending', 'running', 'done', 'partial', 'stopped')),
  dry_run boolean not null default false,
  run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, table_id) references work.review_table (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, context_document_id) references content.document (workspace_id, id)
);
create index rt_column_table_idx on work.rt_column (table_id, ordinal) where deleted_at is null;

-- One document per row for now; grouping (up to 25) needs no schema change.
create table work.rt_row (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  table_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  document_ids uuid[] not null check (cardinality(document_ids) between 1 and 25),
  flag_color text check (flag_color in ('red', 'orange', 'yellow', 'green', 'blue', 'purple')),
  locked boolean not null default false,
  source_removed boolean not null default false,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, table_id) references work.review_table (workspace_id, id)
    on delete cascade
);
create index rt_row_table_idx on work.rt_row (table_id, ordinal) where deleted_at is null;
create index rt_row_documents_idx on work.rt_row using gin (document_ids);

-- A cell exists once its column has run on its row, or someone edited it.
create table work.rt_cell (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  table_id uuid not null,
  row_id uuid not null,
  column_id uuid not null,
  status text not null default 'pending' check (status in
    ('pending', 'queued', 'running', 'done', 'null', 'error', 'blocked', 'stale')),
  error_code text check (error_code in ('DOC_NOT_READY', 'CONTEXT_TOO_LARGE', 'MODEL_ERROR',
    'CITATION_UNVERIFIED', 'PARSE_FAILED', 'ACCESS_DENIED')),
  value_text text check (char_length(value_text) <= 100000),
  value_typed jsonb check (value_typed is null or jsonb_typeof(value_typed) = 'object'),
  reasoning text check (char_length(reasoning) <= 20000),
  looked_at jsonb,
  citation_count integer not null default 0 check (citation_count >= 0),
  verified_citation_count integer not null default 0
    check (verified_citation_count between 0 and citation_count),
  verified_by uuid,
  verified_at timestamptz,
  locked boolean not null default false,
  edited_by uuid,
  flag_color text check (flag_color in ('red', 'orange', 'yellow', 'green', 'blue', 'purple')),
  stale_since timestamptz,
  model text,
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric(12, 6) check (cost_usd >= 0),
  run_id uuid,
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (row_id, column_id),
  check ((status = 'error') = (error_code is not null)),
  check ((verified_at is null) = (verified_by is null)),
  foreign key (workspace_id, table_id) references work.review_table (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, row_id) references work.rt_row (workspace_id, id) on delete cascade,
  foreign key (workspace_id, column_id) references work.rt_column (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, verified_by) references core."user" (workspace_id, id),
  foreign key (workspace_id, edited_by) references core."user" (workspace_id, id)
);
create index rt_cell_status_idx on work.rt_cell (table_id, column_id, status);
create index rt_cell_verified_idx on work.rt_cell (table_id, verified_at)
  where verified_at is not null;

-- Starring is private to each person.
create table work.rt_star (
  table_id uuid not null,
  user_id uuid not null,
  workspace_id uuid not null,
  primary key (table_id, user_id),
  foreign key (workspace_id, table_id) references work.review_table (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);

-- The PRD caps columns per table; checked here so no client can skip it.
create function work.rt_column_limit() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Serialised per table, so two columns added at once can't both see 499.
  perform pg_advisory_xact_lock(hashtextextended(new.table_id::text, 0));
  if (select count(*) from work.rt_column c
       where c.table_id = new.table_id and c.deleted_at is null) >= 500 then
    raise exception 'COLUMN_LIMIT' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger rt_column_limit before insert on work.rt_column
  for each row execute function work.rt_column_limit();
grant execute on function work.rt_column_limit() to legallabs_app;

alter table work.review_table enable row level security;
alter table work.review_table force row level security;
alter table work.rt_column enable row level security;
alter table work.rt_column force row level security;
alter table work.rt_row enable row level security;
alter table work.rt_row force row level security;
alter table work.rt_cell enable row level security;
alter table work.rt_cell force row level security;
alter table work.rt_star enable row level security;
alter table work.rt_star force row level security;

grant select, insert on work.review_table, work.rt_column, work.rt_row, work.rt_cell
  to legallabs_app;
grant update (name, instructions, settings, stats, updated_at, deleted_at)
  on work.review_table to legallabs_app;
grant update (ordinal, label, type, prompt, language, model, context_document_id, options, state,
              dry_run, run_id, updated_at, deleted_at)
  on work.rt_column to legallabs_app;
grant update (flag_color, locked, deleted_at) on work.rt_row to legallabs_app;
grant update (status, error_code, value_text, value_typed, reasoning, looked_at, citation_count,
              verified_citation_count, verified_by, verified_at, locked, edited_by, flag_color,
              stale_since, model, input_tokens, output_tokens, cost_usd, run_id, updated_at)
  on work.rt_cell to legallabs_app;
grant select, insert, delete on work.rt_star to legallabs_app;

-- Owner only for now; walls apply through the matter, and per document through the rows.
create policy review_table_read on work.review_table for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and owner_id = core.current_user_id()
         and deleted_at is null
         and core.can_access_matter(matter_id));
create policy review_table_insert on work.review_table for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and owner_id = core.current_user_id()
              and deleted_at is null
              and core.has_permission('tables.create')
              and core.can_access_matter(matter_id)
              and (vault_id is null
                   or vault_id = any ((select content.readable_vaults('view'))::uuid[])));
create policy review_table_update on work.review_table for update to legallabs_app
  using (core.in_tenant(workspace_id)
         and owner_id = core.current_user_id()
         and deleted_at is null
         and core.can_access_matter(matter_id))
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id());

-- Everything inside a table is reached through it.
create policy rt_column_all on work.rt_column for all to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from work.review_table t where t.id = table_id))
  with check (core.in_tenant(workspace_id)
              and exists (select 1 from work.review_table t where t.id = table_id)
              and (context_document_id is null or exists (
                select 1 from content.document d where d.id = context_document_id)));

-- A row may only name documents the caller can read now; walls are re-checked on every read.
create policy rt_row_all on work.rt_row for all to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from work.review_table t where t.id = table_id))
  with check (core.in_tenant(workspace_id)
              and exists (select 1 from work.review_table t where t.id = table_id)
              and not exists (
                select 1 from unnest(document_ids) x(id)
                 where not exists (select 1 from content.document d where d.id = x.id)));

create policy rt_cell_all on work.rt_cell for all to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from work.review_table t where t.id = table_id))
  with check (core.in_tenant(workspace_id)
              and exists (select 1 from work.review_table t where t.id = table_id));

create policy rt_star_own on work.rt_star for all to legallabs_app
  using (core.in_tenant(workspace_id) and user_id = core.current_user_id())
  with check (core.in_tenant(workspace_id) and user_id = core.current_user_id()
              and exists (select 1 from work.review_table t where t.id = table_id));
