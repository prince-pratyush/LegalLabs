-- Web search as a thread source. A question sent to a search service leaves the workspace, so it
-- is off until an administrator turns it on, and can be forbidden for a matter.

-- One row per workspace; without one, web search is off.
create table work.web_settings (
  workspace_id uuid primary key references core.workspace (id) on delete cascade,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Matters whose work must not be searched for. Kept apart from the matter itself, so someone who
-- may edit their own matter cannot lift the restriction.
create table work.web_blocked_matter (
  workspace_id uuid not null,
  matter_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, matter_id),
  foreign key (workspace_id, matter_id) references core.matter (workspace_id, id) on delete cascade
);

-- The text of pages a run fetched, kept a day so its quotes can be checked. Goes with the run.
create table work.web_fetch_cache (
  run_id uuid not null,
  url text not null check (url like 'https://%' and char_length(url) <= 2000),
  workspace_id uuid not null,
  title text not null check (char_length(title) <= 300),
  text text not null check (char_length(text) between 1 and 200000),
  fetched_at timestamptz not null,
  expires_at timestamptz not null default now() + interval '24 hours'
    check (expires_at <= now() + interval '24 hours'),
  primary key (run_id, url),
  foreign key (workspace_id, run_id) references work.run (workspace_id, id) on delete cascade
);
create index web_fetch_cache_expiry_idx on work.web_fetch_cache (expires_at);

alter table work.web_settings enable row level security;
alter table work.web_settings force row level security;
alter table work.web_blocked_matter enable row level security;
alter table work.web_blocked_matter force row level security;
alter table work.web_fetch_cache enable row level security;
alter table work.web_fetch_cache force row level security;

grant select, insert, update on work.web_settings to legallabs_app;
grant select, insert, delete on work.web_blocked_matter to legallabs_app;
grant select, insert on work.web_fetch_cache to legallabs_app;

create policy web_settings_read on work.web_settings for select to legallabs_app
  using (core.in_tenant(workspace_id));
create policy web_settings_insert on work.web_settings for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));
create policy web_settings_update on work.web_settings for update to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.config'))
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));

-- Every member's searches are held to the list, so every member reads it: ids only.
create policy web_blocked_matter_read on work.web_blocked_matter for select to legallabs_app
  using (core.in_tenant(workspace_id));
create policy web_blocked_matter_insert on work.web_blocked_matter for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and core.has_permission('admin.config'));
create policy web_blocked_matter_delete on work.web_blocked_matter for delete to legallabs_app
  using (core.in_tenant(workspace_id) and core.has_permission('admin.config'));

-- A run's pages are its owner's. The run is looked up under their own policies, so a wall or a
-- lost thread closes them too.
create policy web_fetch_cache_read on work.web_fetch_cache for select to legallabs_app
  using (core.in_tenant(workspace_id) and exists (
    select 1 from work.run r where r.id = run_id and r.owner_id = core.current_user_id()));
create policy web_fetch_cache_insert on work.web_fetch_cache for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and core.has_permission('threads.use') and exists (
    select 1 from work.run r where r.id = run_id and r.owner_id = core.current_user_id()));

create function work.purge_web_fetch_cache() returns bigint
language sql volatile security definer set search_path = '' as $$
  with gone as (
    delete from work.web_fetch_cache where expires_at <= pg_catalog.now() returning 1)
  select count(*) from gone
$$;
grant select, delete on work.web_fetch_cache to legallabs_definer;
create policy definer_purge on work.web_fetch_cache to legallabs_definer
  using (true) with check (true);
alter function work.purge_web_fetch_cache() owner to legallabs_definer;
revoke execute on function work.purge_web_fetch_cache() from public;
grant execute on function work.purge_web_fetch_cache() to legallabs_worker;

-- A citation of a web page: where it was, what it was called and when it was read.
alter table work.citation
  add column web_url text check (web_url like 'https://%' and char_length(web_url) <= 2000),
  add column web_title text check (char_length(web_title) <= 300),
  add column web_fetched_at timestamptz,
  drop constraint citation_kind_check,
  add constraint citation_kind_check check (kind in ('document', 'authority', 'web')),
  drop constraint citation_ok_located,
  add constraint citation_ok_located check (status <> 'ok'
    or (kind = 'document' and version_id is not null and page_no is not null
        and quote is not null and char_from is not null and char_to is not null)
    or (kind = 'authority' and authority_id is not null and quote is not null)
    or (kind = 'web' and web_url is not null and web_fetched_at is not null
        and quote is not null));
