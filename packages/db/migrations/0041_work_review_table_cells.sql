-- Every change to a cell's value, status, verification, lock or flag, never rewritten.
create table work.rt_cell_history (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  table_id uuid not null,
  cell_id uuid not null,
  at timestamptz not null default now(),
  actor_id uuid,
  field text not null check (field in ('value', 'status', 'verified', 'locked', 'flag', 'run')),
  old jsonb,
  new jsonb,
  foreign key (workspace_id, table_id) references work.review_table (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, cell_id) references work.rt_cell (workspace_id, id) on delete cascade,
  foreign key (workspace_id, actor_id) references core."user" (workspace_id, id)
);
create index rt_cell_history_idx on work.rt_cell_history (cell_id, at desc);

-- Like a thread citation, but owned by a cell: pinned to a version, checked by string match.
create table work.rt_cell_citation (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  table_id uuid not null,
  cell_id uuid not null,
  ordinal integer not null check (ordinal >= 1),
  version_id uuid not null,
  page_no integer check (page_no >= 1),
  quote text not null check (char_length(quote) <= 4000),
  char_from integer check (char_from >= 0),
  char_to integer,
  status text not null check (status in ('ok', 'mismatch', 'unresolved')),
  user_edited boolean not null default false,
  unique (cell_id, ordinal),
  check (char_to is null or char_to > char_from),
  -- A verified citation always says exactly where it is.
  check (status <> 'ok' or (page_no is not null and char_from is not null and char_to is not null)),
  foreign key (workspace_id, table_id) references work.review_table (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, cell_id) references work.rt_cell (workspace_id, id) on delete cascade,
  foreign key (workspace_id, version_id) references content.document_version (workspace_id, id)
    on delete cascade
);
create index rt_cell_citation_cell_idx on work.rt_cell_citation (cell_id);

alter table work.rt_cell_history enable row level security;
alter table work.rt_cell_history force row level security;
alter table work.rt_cell_citation enable row level security;
alter table work.rt_cell_citation force row level security;

grant select, insert on work.rt_cell_history to legallabs_app;
-- Replaced as a set when a cell runs again; an edit only marks them.
grant select, insert, delete on work.rt_cell_citation to legallabs_app;
grant update (user_edited) on work.rt_cell_citation to legallabs_app;

create policy rt_cell_history_read on work.rt_cell_history for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from work.review_table t where t.id = table_id));
create policy rt_cell_history_insert on work.rt_cell_history for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and actor_id = core.current_user_id()
              and exists (select 1 from work.review_table t where t.id = table_id));

-- A citation can only point at a version the caller can read, so no wall is crossed.
create policy rt_cell_citation_all on work.rt_cell_citation for all to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from work.review_table t where t.id = table_id))
  with check (core.in_tenant(workspace_id)
              and exists (select 1 from work.review_table t where t.id = table_id)
              and exists (select 1 from content.document_version v where v.id = version_id));
