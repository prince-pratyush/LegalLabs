-- Fact tables for Spaces. A fact is text taken from documents, so it is seen only by Space
-- members who can open every one of those documents now: when access goes, the fact goes too.
-- A document that is purged takes its facts with it.

create table apps.fact (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  space_id uuid not null,
  created_by uuid not null,
  source text not null check (source in ('extracted', 'manual')),
  -- Fixed when the fact is made. Reading it takes all of them.
  source_documents uuid[] not null check (cardinality(source_documents) between 1 and 10),
  text text not null check (char_length(text) between 1 and 1000),
  event_date date check (event_date between '1000-01-01' and '9998-12-31'),
  event_date_end date check (event_date_end between '1000-01-01' and '9998-12-31'),
  date_precision text not null check (date_precision in ('day', 'month', 'year', 'unknown')),
  -- Undated facts sort last.
  sort_date date not null generated always as (coalesce(event_date, '9999-12-31'::date)) stored,
  status text not null default 'extracted'
    check (status in ('extracted', 'confirmed', 'disputed', 'rejected')),
  version_no integer not null default 1 check (version_no >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (space_id, id),
  check ((date_precision = 'unknown') = (event_date is null)),
  check (event_date_end is null or (event_date is not null and event_date_end >= event_date)),
  foreign key (workspace_id, space_id) references work.space (workspace_id, id) on delete cascade,
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id)
);
create index fact_space_date_idx on apps.fact (space_id, sort_date, id);
create index fact_source_idx on apps.fact using gin (source_documents);

create table apps.fact_version (
  fact_id uuid not null,
  no integer not null check (no >= 1),
  workspace_id uuid not null,
  text text not null check (char_length(text) between 1 and 1000),
  event_date date,
  event_date_end date,
  date_precision text not null check (date_precision in ('day', 'month', 'year', 'unknown')),
  entity_ids uuid[] not null default '{}',
  issue_ids uuid[] not null default '{}',
  edited_by uuid not null,
  at timestamptz not null default now(),
  primary key (fact_id, no),
  foreign key (workspace_id, fact_id) references apps.fact (workspace_id, id) on delete cascade,
  foreign key (workspace_id, edited_by) references core."user" (workspace_id, id)
);

create table apps.fact_citation (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  fact_id uuid not null,
  document_id uuid not null,
  document_version_id uuid not null,
  page_no integer not null check (page_no >= 1),
  char_from integer not null check (char_from >= 0),
  char_to integer not null,
  quote text not null check (char_length(quote) between 1 and 4000),
  -- Only a quote found on its page is ever stored.
  verified text not null default 'ok' check (verified = 'ok'),
  check (char_to > char_from),
  foreign key (workspace_id, fact_id) references apps.fact (workspace_id, id) on delete cascade,
  foreign key (workspace_id, document_version_id)
    references content.document_version (workspace_id, id) on delete cascade
);
create index fact_citation_fact_idx on apps.fact_citation (fact_id);
create index fact_citation_version_idx on apps.fact_citation (document_version_id);

-- Names read out of a document stay as closed as the document: an extracted entry is seen only
-- through a fact that extraction linked it to. One a person typed is the Space's.
create table apps.entity (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  space_id uuid not null,
  kind text not null check (kind in ('person', 'org', 'place', 'other')),
  canonical_name text not null check (char_length(canonical_name) between 1 and 200),
  aliases text[] not null default '{}' check (cardinality(aliases) <= 20),
  role text check (char_length(role) <= 200),
  origin text not null check (origin in ('manual', 'extracted')),
  -- A name that may be one already in the table, for a person to sort out.
  provisional boolean not null default false,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (space_id, id),
  foreign key (workspace_id, space_id) references work.space (workspace_id, id) on delete cascade,
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id)
);
create index entity_space_idx on apps.entity (space_id, lower(canonical_name));

create table apps.issue (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  space_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  origin text not null check (origin in ('manual', 'extracted')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (space_id, id),
  foreign key (workspace_id, space_id) references work.space (workspace_id, id) on delete cascade,
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id)
);
create index issue_space_idx on apps.issue (space_id, lower(name));

create table apps.fact_entity (
  fact_id uuid not null,
  entity_id uuid not null,
  space_id uuid not null,
  workspace_id uuid not null,
  via text not null check (via in ('manual', 'extracted')),
  primary key (fact_id, entity_id),
  foreign key (space_id, fact_id) references apps.fact (space_id, id) on delete cascade,
  foreign key (space_id, entity_id) references apps.entity (space_id, id) on delete cascade,
  foreign key (workspace_id, fact_id) references apps.fact (workspace_id, id) on delete cascade
);
create index fact_entity_entity_idx on apps.fact_entity (entity_id);

create table apps.fact_issue (
  fact_id uuid not null,
  issue_id uuid not null,
  space_id uuid not null,
  workspace_id uuid not null,
  via text not null check (via in ('manual', 'extracted')),
  primary key (fact_id, issue_id),
  foreign key (space_id, fact_id) references apps.fact (space_id, id) on delete cascade,
  foreign key (space_id, issue_id) references apps.issue (space_id, id) on delete cascade,
  foreign key (workspace_id, fact_id) references apps.fact (workspace_id, id) on delete cascade
);
create index fact_issue_issue_idx on apps.fact_issue (issue_id);

-- The table's own trail, which holds fact text. The workspace audit log holds ids only.
create table apps.fact_audit (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  space_id uuid not null,
  fact_id uuid,
  actor_id uuid not null,
  action text not null check (char_length(action) between 1 and 40),
  details jsonb not null default '{}' check (jsonb_typeof(details) = 'object'),
  at timestamptz not null default now(),
  -- An entry about no one fact holds counts and ids, never text.
  check (pg_column_size(details) <= case when fact_id is null then 1000 else 10000 end),
  foreign key (workspace_id, space_id) references work.space (workspace_id, id) on delete cascade,
  foreign key (workspace_id, fact_id) references apps.fact (workspace_id, id) on delete cascade,
  foreign key (workspace_id, actor_id) references core."user" (workspace_id, id)
);
create index fact_audit_space_idx on apps.fact_audit (space_id, id desc);
create index fact_audit_fact_idx on apps.fact_audit (fact_id);

-- The Spaces whose fact tables the caller works in: members only, never guests. Read once per
-- statement rather than once per row.
create function apps.fact_spaces() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(s.id), '{}')
    from work.space s
   where s.workspace_id = core.current_workspace_id()
     and core.is_active_member()
     and work.space_role(s.id) in ('admin', 'collaborator')
$$;
alter function apps.fact_spaces() owner to legallabs_definer;
revoke execute on function apps.fact_spaces() from public;
grant execute on function apps.fact_spaces() to legallabs_app;

alter table apps.fact enable row level security;
alter table apps.fact force row level security;
alter table apps.fact_version enable row level security;
alter table apps.fact_version force row level security;
alter table apps.fact_citation enable row level security;
alter table apps.fact_citation force row level security;
alter table apps.entity enable row level security;
alter table apps.entity force row level security;
alter table apps.issue enable row level security;
alter table apps.issue force row level security;
alter table apps.fact_entity enable row level security;
alter table apps.fact_entity force row level security;
alter table apps.fact_issue enable row level security;
alter table apps.fact_issue force row level security;
alter table apps.fact_audit enable row level security;
alter table apps.fact_audit force row level security;

-- No delete: a fact is rejected, not removed. What it cites and who made it never change.
grant select, insert on apps.fact to legallabs_app;
grant update (text, event_date, event_date_end, date_precision, status, version_no, updated_at)
  on apps.fact to legallabs_app;
grant select, insert on apps.fact_version, apps.fact_citation, apps.fact_audit to legallabs_app;
grant select, insert on apps.entity, apps.issue to legallabs_app;
grant update (kind, canonical_name, aliases, role, origin, provisional, updated_at)
  on apps.entity to legallabs_app;
grant update (name, description, origin, updated_at) on apps.issue to legallabs_app;
grant select, insert, delete on apps.fact_entity, apps.fact_issue to legallabs_app;

-- The one rule on who sees a fact. The document count runs under the caller's own policies, so
-- vault access, matter walls, the recycle bin and the intake wall all apply.
create policy fact_read on apps.fact for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and space_id = any ((select apps.fact_spaces())::uuid[])
         and (select count(*) from content.document d where d.id = any (source_documents))
             = cardinality(source_documents));
-- New facts cite files in vaults shared with the Space, never the intake Inbox.
create policy fact_insert on apps.fact for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and space_id = any ((select apps.fact_spaces())::uuid[])
              and created_by = core.current_user_id()
              and created_at = now()
              and status = 'extracted'
              and version_no = 1
              and (select count(*) from content.document d
                    where d.id = any (source_documents)
                      and not apps.is_intake_vault(d.vault_id)
                      and exists (select 1 from work.space_resource r
                                   where r.space_id = fact.space_id
                                     and r.resource_type = 'vault'
                                     and r.resource_id = d.vault_id
                                     and r.suspended_reason is null))
                  = cardinality(source_documents));
create policy fact_update on apps.fact for update to legallabs_app
  using (core.in_tenant(workspace_id)
         and space_id = any ((select apps.fact_spaces())::uuid[])
         and (select count(*) from content.document d where d.id = any (source_documents))
             = cardinality(source_documents))
  with check (core.in_tenant(workspace_id)
              and space_id = any ((select apps.fact_spaces())::uuid[]));

-- Everything under a fact is seen by whoever sees the fact.
create policy fact_version_read on apps.fact_version for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from apps.fact f where f.id = fact_id));
create policy fact_version_insert on apps.fact_version for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and edited_by = core.current_user_id() and at = now()
              and exists (select 1 from apps.fact f
                           where f.id = fact_id and f.version_no = fact_version.no));

create policy fact_citation_read on apps.fact_citation for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from apps.fact f where f.id = fact_id));
-- Written with the fact and never after, and only to a document the fact names.
create policy fact_citation_insert on apps.fact_citation for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and exists (select 1 from apps.fact f
                           where f.id = fact_id and f.created_by = core.current_user_id()
                             and f.created_at = now()
                             and document_id = any (f.source_documents))
              and exists (select 1 from content.document_version v
                           where v.id = document_version_id
                             and v.document_id = fact_citation.document_id));

create policy entity_read on apps.entity for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and space_id = any ((select apps.fact_spaces())::uuid[])
         and (origin = 'manual'
              or exists (select 1 from apps.fact_entity l
                          where l.entity_id = entity.id and l.via = 'extracted')));
create policy entity_insert on apps.entity for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and space_id = any ((select apps.fact_spaces())::uuid[])
              and created_by = core.current_user_id());
create policy entity_update on apps.entity for update to legallabs_app
  using (core.in_tenant(workspace_id) and space_id = any ((select apps.fact_spaces())::uuid[]))
  with check (core.in_tenant(workspace_id)
              and space_id = any ((select apps.fact_spaces())::uuid[]));

create policy issue_read on apps.issue for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and space_id = any ((select apps.fact_spaces())::uuid[])
         and (origin = 'manual'
              or exists (select 1 from apps.fact_issue l
                          where l.issue_id = issue.id and l.via = 'extracted')));
create policy issue_insert on apps.issue for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and space_id = any ((select apps.fact_spaces())::uuid[])
              and created_by = core.current_user_id());
create policy issue_update on apps.issue for update to legallabs_app
  using (core.in_tenant(workspace_id) and space_id = any ((select apps.fact_spaces())::uuid[]))
  with check (core.in_tenant(workspace_id)
              and space_id = any ((select apps.fact_spaces())::uuid[]));

-- A link made by hand never opens a name; only extraction, as it makes the fact, can.
create policy fact_entity_read on apps.fact_entity for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from apps.fact f where f.id = fact_id));
create policy fact_entity_insert on apps.fact_entity for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and exists (select 1 from apps.fact f
                           where f.id = fact_id
                             and (via = 'manual'
                                  or (f.source = 'extracted' and f.created_at = now()
                                      and f.created_by = core.current_user_id()))));
create policy fact_entity_delete on apps.fact_entity for delete to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from apps.fact f where f.id = fact_id));

create policy fact_issue_read on apps.fact_issue for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from apps.fact f where f.id = fact_id));
create policy fact_issue_insert on apps.fact_issue for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and exists (select 1 from apps.fact f
                           where f.id = fact_id
                             and (via = 'manual'
                                  or (f.source = 'extracted' and f.created_at = now()
                                      and f.created_by = core.current_user_id()))));
create policy fact_issue_delete on apps.fact_issue for delete to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from apps.fact f where f.id = fact_id));

create policy fact_audit_read on apps.fact_audit for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and space_id = any ((select apps.fact_spaces())::uuid[])
         and (fact_id is null or exists (select 1 from apps.fact f where f.id = fact_id)));
create policy fact_audit_insert on apps.fact_audit for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and space_id = any ((select apps.fact_spaces())::uuid[])
              and actor_id = core.current_user_id() and at = now()
              and (fact_id is null
                   or exists (select 1 from apps.fact f
                               where f.id = fact_id and f.space_id = fact_audit.space_id)));

-- An edit moves the version on by one, and a change of words or date can't be made without it.
-- A name a person typed stays theirs.
create function apps.fact_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'fact' then
    if new.version_no not in (old.version_no, old.version_no + 1)
       or ((new.text, new.event_date, new.event_date_end, new.date_precision)
             is distinct from
           (old.text, old.event_date, old.event_date_end, old.date_precision)
           and new.version_no = old.version_no) then
      raise exception 'an edit makes a new version' using errcode = '42501';
    end if;
  elsif new.origin <> old.origin and new.origin <> 'manual' then
    raise exception 'a typed name stays typed' using errcode = '42501';
  end if;
  return new;
end
$$;
grant execute on function apps.fact_guard() to legallabs_app;
create trigger fact_guard before update on apps.fact
  for each row execute function apps.fact_guard();
create trigger entity_guard before update on apps.entity
  for each row execute function apps.fact_guard();
create trigger issue_guard before update on apps.issue
  for each row execute function apps.fact_guard();

-- Checked as the transaction ends: every fact has a quote from each document it names, and every
-- version of it is kept.
create function apps.fact_complete() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from unnest(new.source_documents) s (id)
              where not exists (select 1 from apps.fact_citation c
                                 where c.fact_id = new.id and c.document_id = s.id)) then
    raise exception 'a fact needs a quote from each of its documents'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from apps.fact_version v
                  where v.fact_id = new.id and v.no = new.version_no) then
    raise exception 'a fact keeps every version' using errcode = 'check_violation';
  end if;
  return null;
end
$$;
grant execute on function apps.fact_complete() to legallabs_app;
create constraint trigger fact_complete after insert on apps.fact
  deferrable initially deferred for each row execute function apps.fact_complete();
create constraint trigger fact_versioned after update of version_no on apps.fact
  deferrable initially deferred for each row execute function apps.fact_complete();

-- Retention: a purged document's quotes cascade away, and its facts, with their versions and
-- trail, go with them. Names left with nothing extracted to show them go too.
grant select, delete on apps.fact, apps.entity, apps.issue to legallabs_definer;
grant select on apps.fact_entity, apps.fact_issue to legallabs_definer;
create policy definer_all on apps.fact for all to legallabs_definer using (true) with check (true);
create policy definer_all on apps.entity for all to legallabs_definer
  using (true) with check (true);
create policy definer_all on apps.issue for all to legallabs_definer using (true) with check (true);
create policy definer_read on apps.fact_entity for select to legallabs_definer using (true);
create policy definer_read on apps.fact_issue for select to legallabs_definer using (true);

create function apps.fact_forget() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'fact_citation' then
    delete from apps.fact f where f.id = old.fact_id;
  elsif tg_table_name = 'fact_entity' then
    delete from apps.entity e
     where e.id = old.entity_id and e.origin = 'extracted'
       and not exists (select 1 from apps.fact_entity l
                        where l.entity_id = e.id and l.via = 'extracted');
  else
    delete from apps.issue i
     where i.id = old.issue_id and i.origin = 'extracted'
       and not exists (select 1 from apps.fact_issue l
                        where l.issue_id = i.id and l.via = 'extracted');
  end if;
  return null;
end
$$;
alter function apps.fact_forget() owner to legallabs_definer;
revoke execute on function apps.fact_forget() from public;
create trigger fact_citation_forget after delete on apps.fact_citation
  for each row execute function apps.fact_forget();
create trigger fact_entity_forget after delete on apps.fact_entity
  for each row execute function apps.fact_forget();
create trigger fact_issue_forget after delete on apps.fact_issue
  for each row execute function apps.fact_forget();
