-- Parsing moves out of the request, so the counts are known only once a job finishes.
alter table content.document_version alter column page_count drop not null;

-- Only this role claims jobs, so no request session can list other tenants' work.
do $$
begin
  if not exists (select from pg_roles where rolname = 'legallabs_worker') then
    create role legallabs_worker nologin;
  end if;
end
$$;
grant legallabs_worker to legallabs_api;
grant usage on schema content to legallabs_worker;

-- One job per version: the version id is the idempotency key.
create table content.ingest_job (
  version_id uuid primary key,
  workspace_id uuid not null,
  status text not null default 'queued'
    check (status in ('queued', 'parsing', 'indexed', 'failed')),
  reason text check (reason ~ '^[A-Z_]{1,40}$'),
  attempts integer not null default 0 check (attempts >= 0),
  run_after timestamptz not null default now(),
  leased_until timestamptz,
  -- Secret to the worker holding the job, so nobody else can settle it.
  lease uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'failed') = (reason is not null)),
  foreign key (workspace_id, version_id)
    references content.document_version (workspace_id, id) on delete cascade
);
create index ingest_job_due_idx on content.ingest_job (run_after)
  where status in ('queued', 'parsing');

alter table content.ingest_job enable row level security;
alter table content.ingest_job force row level security;

-- Status changes only go through the functions below, which check the attempt number.
grant select, insert on content.ingest_job to legallabs_app;
grant usage on schema content to legallabs_definer;
grant select, update on content.ingest_job to legallabs_definer;
grant select on content.document to legallabs_definer;
grant select, update (page_count, empty_page_count) on content.document_version
  to legallabs_definer;
grant select on content.page to legallabs_definer;

create policy job_read on content.ingest_job for select to legallabs_app
  using (core.in_tenant(workspace_id) and exists (
    select 1 from content.document_version v where v.id = version_id));
create policy job_insert on content.ingest_job for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and status = 'queued' and attempts = 0 and reason is null
              and exists (select 1 from content.document_version v
                           where v.id = version_id and v.created_by = core.current_user_id()));
create policy definer_job on content.ingest_job for all to legallabs_definer
  using (true) with check (true);
create policy definer_version_read on content.document_version for select
  to legallabs_definer using (true);
-- Counts are written once, when a job finishes.
create policy definer_version_count on content.document_version for update
  to legallabs_definer using (page_count is null) with check (true);
create policy definer_page on content.page for select to legallabs_definer using (true);
create policy definer_document on content.document for select to legallabs_definer
  using (true);

-- Takes the next due job, or one whose worker stopped renewing its lease.
create function content.claim_ingest_job(
  lease_seconds integer,
  max_attempts integer,
  only_workspace uuid default null
) returns table (version_id uuid, workspace_id uuid, document_id uuid, created_by uuid,
                 sha256 bytea, attempt integer, lease uuid)
language plpgsql security definer set search_path = '' as $$
begin
  -- A file that kills its worker never reports back, so its lapsed lease counts as a failure.
  update content.ingest_job j
     set status = 'failed', reason = 'INTERNAL', lease = null, leased_until = null,
         updated_at = now()
   where j.status = 'parsing' and j.leased_until < now() and j.attempts >= max_attempts
     and (only_workspace is null or j.workspace_id = only_workspace);
  return query
  with next as (
    select j.version_id
      from content.ingest_job j
     where (only_workspace is null or j.workspace_id = only_workspace)
       and ((j.status = 'queued' and j.run_after <= now())
            or (j.status = 'parsing' and j.leased_until < now()))
     order by j.run_after
     limit 1
       for update skip locked
  ), claimed as (
    update content.ingest_job j
       set status = 'parsing', attempts = j.attempts + 1, updated_at = now(),
           lease = gen_random_uuid(),
           leased_until = now() + make_interval(secs => greatest(lease_seconds, 1))
      from next
     where j.version_id = next.version_id
    returning j.version_id, j.workspace_id, j.attempts, j.lease
  )
  select c.version_id, c.workspace_id, v.document_id, v.created_by, v.sha256, c.attempts, c.lease
    from claimed c
    join content.document_version v on v.id = c.version_id;
end
$$;

-- A long read keeps its job by renewing; false means it has already lost it.
create function content.renew_ingest_lease(p_version_id uuid, p_lease uuid, lease_seconds integer)
returns boolean
language sql security definer set search_path = '' as $$
  with renewed as (
    update content.ingest_job j
       set leased_until = now() + make_interval(secs => greatest(lease_seconds, 1))
     where j.version_id = p_version_id and j.lease = p_lease and j.status = 'parsing'
    returning 1
  )
  select exists (select 1 from renewed)
$$;

-- False means the lease was lost, so the caller must roll back.
create function content.finish_ingest_job(
  p_version_id uuid,
  p_lease uuid,
  p_status text,
  p_reason text default null,
  p_retry_seconds integer default null
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
begin
  if p_status not in ('indexed', 'failed', 'queued') then
    raise exception 'unknown job status' using errcode = '22023';
  end if;
  update content.ingest_job j
     set status = p_status,
         reason = case when p_status = 'failed' then p_reason end,
         run_after = case when p_status = 'queued'
                          then now() + make_interval(secs => greatest(coalesce(p_retry_seconds, 0), 0))
                          else j.run_after end,
         lease = null,
         leased_until = null,
         updated_at = now()
   where j.version_id = p_version_id
     and j.lease = p_lease
     and j.status = 'parsing'
     and core.in_tenant(j.workspace_id)
  returning j.workspace_id into ws;
  if ws is null then
    return false;
  end if;
  -- Counted from the rows themselves, so a caller can't claim pages that aren't there.
  if p_status = 'indexed' then
    update content.document_version v
       set page_count = c.pages, empty_page_count = c.empty
      from (select count(*)::integer pages,
                   count(*) filter (where btrim(p.text) = '')::integer empty
              from content.page p where p.version_id = p_version_id) c
     where v.id = p_version_id and v.page_count is null and c.pages > 0;
    if not found then
      raise exception 'an indexed version needs its pages' using errcode = '23514';
    end if;
  end if;
  return true;
end
$$;

-- The uploader may re-queue a failed file while they can still reach its matter.
create function content.retry_ingest_job(p_version_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  found_id uuid;
begin
  update content.ingest_job j
     set status = 'queued', reason = null, attempts = 0, run_after = now(),
         leased_until = null, updated_at = now()
    from content.document_version v
    join content.document d on d.id = v.document_id
   where j.version_id = p_version_id
     and v.id = j.version_id
     and j.status = 'failed'
     -- A pause between tries, so a script can't keep the worker busy with one file.
     and j.updated_at < now() - interval '1 minute'
     and core.in_tenant(j.workspace_id)
     and v.created_by = core.current_user_id()
     and d.owner_id = core.current_user_id()
     and core.can_access_matter(d.matter_id)
     and core.has_permission('threads.use')
  returning j.version_id into found_id;
  return found_id is not null;
end
$$;

alter function content.claim_ingest_job(integer, integer, uuid) owner to legallabs_definer;
alter function content.renew_ingest_lease(uuid, uuid, integer) owner to legallabs_definer;
alter function content.finish_ingest_job(uuid, uuid, text, text, integer)
  owner to legallabs_definer;
alter function content.retry_ingest_job(uuid) owner to legallabs_definer;
revoke execute on all functions in schema content from public;
grant execute on function content.claim_ingest_job(integer, integer, uuid),
  content.renew_ingest_lease(uuid, uuid, integer)
  to legallabs_worker;
grant execute on function content.finish_ingest_job(uuid, uuid, text, text, integer),
  content.retry_ingest_job(uuid)
  to legallabs_app;
