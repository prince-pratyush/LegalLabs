-- Playbook reviews (playbooks-word.md §4.3, §6). A review is a run of kind playbook_review
-- with no thread: it reads one document version against one playbook version.
alter table work.run
  drop constraint run_kind_check,
  add constraint run_kind_check check (kind in ('thread', 'deep_analysis', 'playbook_review')),
  alter column thread_id drop not null,
  alter column question_id drop not null,
  -- Thread runs still answer a question in a thread; only a review stands alone.
  add constraint run_thread_check check (kind = 'playbook_review'
                                         or (thread_id is not null and question_id is not null));

-- One row per phase of a run, with its model and cost (WRD-003-a). Refs are keys, never content.
create table work.run_step (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  run_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  kind text not null check (kind in ('plan', 'retrieve', 'tool', 'generate', 'verify',
                                     'ask_user', 'draft')),
  status text not null check (status in ('done', 'failed', 'cancelled')),
  model text,
  input_ref text check (char_length(input_ref) <= 500),
  output_ref text check (char_length(output_ref) <= 500),
  usage jsonb not null default '{}' check (jsonb_typeof(usage) = 'object'),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (run_id, ordinal),
  foreign key (workspace_id, run_id) references work.run (workspace_id, id) on delete cascade
);

create table work.playbook_review (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  run_id uuid not null,
  owner_id uuid not null,
  playbook_id uuid not null,
  playbook_version_id uuid not null,
  -- A copy of what the review ran against: a deleted playbook hides its versions.
  playbook_name text not null check (char_length(playbook_name) between 1 and 200),
  rules jsonb not null check (jsonb_typeof(rules) = 'array'),
  guidance text,
  document_id uuid not null,
  document_version_id uuid not null,
  surface text not null check (surface in ('web', 'word')),
  thread_id uuid,
  customisation jsonb not null check (jsonb_typeof(customisation) = 'object'),
  status text not null default 'planned' check (status in ('planned', 'running', 'verifying',
                                                            'done', 'failed', 'cancelled')),
  summary jsonb not null default '{"acceptable":0,"needs_review":0,"not_acceptable":0,"not_found":0,"gaps":0}',
  warnings text[] not null default '{}',
  results jsonb not null default '[]' check (jsonb_typeof(results) = 'array'),
  gaps jsonb not null default '[]' check (jsonb_typeof(gaps) = 'array'),
  clause_map jsonb not null default '{}' check (jsonb_typeof(clause_map) = 'object'),
  excluded_regions jsonb not null default '{}' check (jsonb_typeof(excluded_regions) = 'object'),
  usage jsonb not null default '{"input_tokens":0,"output_tokens":0,"cost_usd":0,"models":[]}',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (run_id),
  foreign key (workspace_id, run_id) references work.run (workspace_id, id) on delete cascade,
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id),
  foreign key (workspace_id, playbook_version_id)
    references work.playbook_version (workspace_id, id),
  foreign key (workspace_id, document_version_id)
    references content.document_version (workspace_id, id) on delete cascade,
  foreign key (workspace_id, thread_id) references work.thread (workspace_id, id)
    on delete set null (thread_id)
);
create index playbook_review_version_idx on work.playbook_review (document_version_id);
create index playbook_review_document_idx on work.playbook_review (document_id, started_at desc);
create index playbook_review_playbook_idx on work.playbook_review (playbook_id, started_at desc);
create index playbook_review_workspace_idx on work.playbook_review (workspace_id, started_at desc);

create table work.review_suggestion (
  id uuid primary key,
  workspace_id uuid not null,
  review_id uuid not null,
  rule_id uuid,
  gap_id uuid,
  kind text not null check (kind in ('replace', 'insert_after')),
  anchor jsonb not null check (jsonb_typeof(anchor) = 'object'),
  before text not null,
  after text not null,
  justification text not null check (char_length(justification) <= 2000),
  status text not null default 'pending' check (status in ('pending', 'applied', 'dismissed',
                                                          'superseded', 'anchor_failed')),
  applied_with_comment boolean not null default false,
  surface text check (surface in ('web', 'word')),
  decided_by uuid,
  decided_at timestamptz,
  superseded_by uuid,
  -- Set when the user applied one of the alternates instead of the main text.
  alternate_id uuid,
  alternates jsonb not null default '[]' check (jsonb_typeof(alternates) = 'array'
                                                and jsonb_array_length(alternates) <= 3),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((rule_id is null) <> (gap_id is null)),
  check ((decided_by is null) = (decided_at is null)),
  foreign key (workspace_id, review_id) references work.playbook_review (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, decided_by) references core."user" (workspace_id, id)
);
create index review_suggestion_status_idx on work.review_suggestion (review_id, status);

alter table work.run_step enable row level security;
alter table work.run_step force row level security;
alter table work.playbook_review enable row level security;
alter table work.playbook_review force row level security;
alter table work.review_suggestion enable row level security;
alter table work.review_suggestion force row level security;

-- Seen by whoever can read the document (vault access and walls included) and either the
-- playbook or, as the one who ran it, their own review. Driven only by the one who ran it.
grant select, insert on work.playbook_review to legallabs_app;
grant update (status, summary, warnings, results, gaps, clause_map, excluded_regions, usage,
              finished_at, updated_at)
  on work.playbook_review to legallabs_app;
create policy playbook_review_read on work.playbook_review for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from content.document_version v where v.id = document_version_id)
         and (owner_id = core.current_user_id() or work.playbook_level(playbook_id) is not null));
create policy playbook_review_insert on work.playbook_review for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and owner_id = core.current_user_id()
              and core.has_permission('playbooks.use')
              and work.playbook_level(playbook_id) is not null
              and exists (select 1 from work.playbook_version pv
                           where pv.id = playbook_review.playbook_version_id
                             and pv.playbook_id = playbook_review.playbook_id)
              and exists (select 1 from content.document_version v
                           where v.id = playbook_review.document_version_id
                             and v.document_id = playbook_review.document_id));
create policy playbook_review_update on work.playbook_review for update to legallabs_app
  using (core.in_tenant(workspace_id) and owner_id = core.current_user_id()
         and core.has_permission('playbooks.use')
         and exists (select 1 from content.document_version v where v.id = document_version_id))
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id());

grant select, insert on work.review_suggestion to legallabs_app;
grant update (status, applied_with_comment, surface, decided_by, decided_at, superseded_by,
              alternate_id, alternates)
  on work.review_suggestion to legallabs_app;
create policy review_suggestion_read on work.review_suggestion for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from work.playbook_review r where r.id = review_id));
create policy review_suggestion_insert on work.review_suggestion for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and exists (
    select 1 from work.playbook_review r
     where r.id = review_id and r.owner_id = core.current_user_id()));
create policy review_suggestion_update on work.review_suggestion for update to legallabs_app
  using (core.in_tenant(workspace_id) and exists (
    select 1 from work.playbook_review r
     where r.id = review_id and r.owner_id = core.current_user_id()))
  with check (core.in_tenant(workspace_id));

-- A review's run carries no clause text, so its owner sees it even before the review row.
create policy run_review_read on work.run for select to legallabs_app
  using (core.in_tenant(workspace_id) and kind = 'playbook_review'
         and (owner_id = core.current_user_id()
              or exists (select 1 from work.playbook_review r where r.run_id = run.id)));
create policy run_review_insert on work.run for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and kind = 'playbook_review'
              and thread_id is null
              and owner_id = core.current_user_id()
              and core.has_permission('playbooks.use'));
create policy run_review_update on work.run for update to legallabs_app
  using (core.in_tenant(workspace_id) and kind = 'playbook_review'
         and owner_id = core.current_user_id() and core.has_permission('playbooks.use'))
  with check (core.in_tenant(workspace_id) and owner_id = core.current_user_id());
create policy run_event_review_insert on work.run_event for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and core.has_permission('playbooks.use') and exists (
    select 1 from work.run r
     where r.id = run_id and r.kind = 'playbook_review'
       and r.owner_id = core.current_user_id()));

grant select, insert on work.run_step to legallabs_app;
create policy run_step_read on work.run_step for select to legallabs_app
  using (core.in_tenant(workspace_id) and exists (select 1 from work.run r where r.id = run_id));
create policy run_step_insert on work.run_step for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and exists (
    select 1 from work.run r where r.id = run_id and r.owner_id = core.current_user_id()));
