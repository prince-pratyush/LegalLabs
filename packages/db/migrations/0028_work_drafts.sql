-- A draft belongs to a thread and is seen by whoever can see that thread.
create table work.draft (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  thread_id uuid not null,
  owner_id uuid not null,
  kind text not null check (kind in ('notepad', 'editor')),
  title text not null check (char_length(title) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, thread_id) references work.thread (workspace_id, id) on delete cascade,
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id)
);
create index draft_thread_idx on work.draft (thread_id, id);

-- Versions are never changed, so "show edits" always compares what was really there.
create table work.draft_version (
  draft_id uuid not null,
  no integer not null check (no >= 1),
  workspace_id uuid not null,
  body text not null check (char_length(body) <= 1000000),
  author text not null check (author in ('assistant', 'user')),
  created_by uuid not null,
  diff_meta jsonb not null default '{}' check (jsonb_typeof(diff_meta) = 'object'),
  created_at timestamptz not null default now(),
  primary key (draft_id, no),
  foreign key (workspace_id, draft_id) references work.draft (workspace_id, id) on delete cascade
);

-- The PRD caps drafts per thread; checked here so no client can skip it.
create function work.draft_limit() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Serialised per thread, so two drafts created at once can't both see 19.
  perform pg_advisory_xact_lock(hashtextextended(new.thread_id::text, 0));
  if (select count(*) from work.draft d where d.thread_id = new.thread_id) >= 20 then
    raise exception 'LIMIT_DRAFTS' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger draft_limit before insert on work.draft
  for each row execute function work.draft_limit();
grant execute on function work.draft_limit() to legallabs_app;

alter table work.draft enable row level security;
alter table work.draft force row level security;
alter table work.draft_version enable row level security;
alter table work.draft_version force row level security;

grant select, insert on work.draft, work.draft_version to legallabs_app;

create policy draft_read on work.draft for select to legallabs_app
  using (core.in_tenant(workspace_id) and exists (
    select 1 from work.thread t where t.id = thread_id));
create policy draft_insert on work.draft for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and owner_id = core.current_user_id()
              and core.has_permission('threads.use')
              and exists (select 1 from work.thread t
                           where t.id = thread_id and t.owner_id = core.current_user_id()));

create policy draft_version_read on work.draft_version for select to legallabs_app
  using (core.in_tenant(workspace_id) and exists (
    select 1 from work.draft d where d.id = draft_id));
create policy draft_version_insert on work.draft_version for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and created_by = core.current_user_id()
              and core.has_permission('threads.use')
              and exists (select 1 from work.draft d
                           where d.id = draft_id and d.owner_id = core.current_user_id()));
