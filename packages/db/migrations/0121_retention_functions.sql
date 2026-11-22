-- Small helpers first. They run as whoever calls them, which is always another retention
-- function owned by the definer, so none of them is granted to the app role.
create function retention._require_admin() returns void
language plpgsql stable set search_path = '' as $$
begin
  if not core.has_permission('admin.retention') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
end
$$;

create function retention._check_scope(p_ws uuid, p_scope text, p_scope_id uuid) returns void
language plpgsql stable set search_path = '' as $$
begin
  if p_scope is null or p_scope not in ('workspace', 'vault', 'matter') or p_scope_id is null then
    raise exception 'INVALID_SCOPE' using errcode = '22023';
  end if;
  if (p_scope = 'workspace' and p_scope_id is distinct from p_ws)
     or (p_scope = 'vault' and not exists (
           select 1 from content.vault v
            where v.id = p_scope_id and v.workspace_id = p_ws and v.deleted_at is null))
     or (p_scope = 'matter' and not exists (
           select 1 from core.matter m where m.id = p_scope_id and m.workspace_id = p_ws)) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
end
$$;

-- The caller's address and browser go in when the request set them; the sweep sets neither.
create function retention._audit(p_actor text, p_action text, p_type text, p_id text,
                                 p_details jsonb) returns void
language plpgsql set search_path = '' as $$
begin
  perform admin.append_audit_event(
    p_action, p_actor, case when p_actor = 'user' then core.current_user_id() end,
    p_type, p_id, p_details,
    nullif(pg_catalog.current_setting('app.client_ip', true), '')::inet,
    nullif(pg_catalog.current_setting('app.ua_hash', true), ''));
end
$$;

create function retention._is_held(p_ws uuid, p_type text, p_id uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from retention.hold h
     where h.workspace_id = p_ws
       and ((h.object_type = p_type and h.object_id = p_id)
            or (h.object_type = 'vault' and p_type = 'document'
                and h.object_id = (select d.vault_id from content.document d where d.id = p_id))
            or (h.object_type = 'matter' and h.object_id = case p_type
                  when 'thread' then (select t.matter_id from work.thread t where t.id = p_id)
                  when 'review_table' then (select r.matter_id from work.review_table r
                                             where r.id = p_id)
                  when 'document' then (select coalesce(d.matter_id, v.matter_id)
                                          from content.document d
                                          left join content.vault v on v.id = d.vault_id
                                         where d.id = p_id) end)))
$$;

create function retention._admin_ids(p_ws uuid) returns uuid[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(u.id order by u.id), '{}')
    from core."user" u left join core.role r on r.id = u.role_id and r.workspace_id = u.workspace_id
   where u.workspace_id = p_ws and u.status = 'active' and u.kind = 'member'
     and ('*' = any (coalesce(r.permissions, '{}'))
          or 'admin.retention' = any (u.extra_permissions || coalesce(r.permissions, '{}')))
$$;

/*
 * Every live object whose time is up under the effective policy, or will be within p_horizon.
 * The estimate and the sweep both read this, so what an admin is shown is what is deleted.
 *
 * Effective hours: the most specific scope with a policy row wins (matter, then vault, then
 * workspace). When an object has both a matter and a vault policy the shortest applies; a row
 * with no hours is an explicit "keep for ever" at its scope. A vault's old retention_hours
 * counts as its vault policy until a policy row replaces it. p_scope, p_scope_id and p_hours
 * stand in for that scope's row, which is how the estimate looks at a change before saving it.
 *
 * Covered: threads, vault files, review tables. Never selected: library items and templates,
 * template files, audit events, usage events, daily analytics, matter records.
 */
create function retention.expired_objects(
  p_workspace uuid,
  p_scope text default null,
  p_scope_id uuid default null,
  p_hours integer default null,
  p_horizon interval default interval '0'
) returns table (
  object_type text, object_id uuid, vault_id uuid, matter_id uuid, label text,
  basis_at timestamptz, hours integer, expires_at timestamptz,
  policy_id uuid, policy_scope text, held boolean)
language plpgsql stable set search_path = '' as $$
#variable_conflict use_column
begin
  return query
  with pol0 as (
    select p.scope, p.scope_id, p.hours, p.id from retention.policy p
     where p.workspace_id = p_workspace
       and (p_scope is null or not (p.scope = p_scope and p.scope_id = p_scope_id))
    union all
    select p_scope, p_scope_id, p_hours, null::uuid where p_scope is not null
  ), pol as (
    select * from pol0
    union all
    select 'vault', v.id, v.retention_hours, null::uuid from content.vault v
     where v.workspace_id = p_workspace and v.retention_hours is not null
       and not exists (select 1 from pol0 x where x.scope = 'vault' and x.scope_id = v.id)
  ), cand as (
    select 'thread'::text ot, t.id oid, null::uuid vid, t.matter_id mid, t.title lbl,
           t.last_activity_at b
      from work.thread t where t.workspace_id = p_workspace and t.deleted_at is null
    union all
    select 'document', d.id, d.vault_id, coalesce(d.matter_id, v.matter_id), d.name,
           greatest(d.created_at, d.restored_at,
                    (select max(dv.created_at) from content.document_version dv
                      where dv.document_id = d.id))
      from content.document d join content.vault v on v.id = d.vault_id
     where d.workspace_id = p_workspace and d.deleted_at is null and v.deleted_at is null
    union all
    select 'review_table', r.id, null::uuid, r.matter_id, r.name, r.updated_at
      from work.review_table r where r.workspace_id = p_workspace and r.deleted_at is null
  ), eff as (
    select c.*,
           case when mp.scope_id is not null and vp.scope_id is not null
                  then least(mp.hours, vp.hours)
                when mp.scope_id is not null then mp.hours
                when vp.scope_id is not null then vp.hours
                else wp.hours end hrs,
           case when mp.scope_id is not null and vp.scope_id is not null
                  then (case when mp.hours is not null and (vp.hours is null or mp.hours <= vp.hours)
                             then mp.id else vp.id end)
                when mp.scope_id is not null then mp.id
                when vp.scope_id is not null then vp.id
                else wp.id end pid,
           case when mp.scope_id is not null and vp.scope_id is not null
                  then (case when mp.hours is not null and (vp.hours is null or mp.hours <= vp.hours)
                             then 'matter' else 'vault' end)
                when mp.scope_id is not null then 'matter'
                when vp.scope_id is not null then 'vault'
                when wp.scope_id is not null then 'workspace' end pscope
      from cand c
      left join pol mp on mp.scope = 'matter' and mp.scope_id = c.mid
      left join pol vp on vp.scope = 'vault' and vp.scope_id = c.vid
      left join pol wp on wp.scope = 'workspace' and wp.scope_id = p_workspace
  )
  select e.ot, e.oid, e.vid, e.mid, e.lbl, e.b, e.hrs,
         e.b + make_interval(hours => e.hrs), e.pid, e.pscope,
         exists (select 1 from retention.hold h
                  where h.workspace_id = p_workspace
                    and ((h.object_type = e.ot and h.object_id = e.oid)
                         or (h.object_type = 'vault' and h.object_id = e.vid)
                         or (h.object_type = 'matter' and h.object_id = e.mid)))
    from eff e
   where e.hrs is not null and e.b + make_interval(hours => e.hrs) <= now() + p_horizon;
end
$$;

-- What a change would delete: counts by type, the total, and when the first deletion is due.
create function retention.estimate(p_scope text, p_scope_id uuid, p_hours integer)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  result jsonb;
begin
  perform retention._require_admin();
  perform retention._check_scope(ws, p_scope, p_scope_id);
  if p_hours is not null and p_hours < 3 then
    raise exception 'RETENTION_MIN' using errcode = '22023';
  end if;
  select jsonb_build_object(
           'threads', count(*) filter (where e.object_type = 'thread' and not e.held),
           'documents', count(*) filter (where e.object_type = 'document' and not e.held),
           'review_tables', count(*) filter (where e.object_type = 'review_table' and not e.held),
           'total', count(*) filter (where not e.held),
           'held', count(*) filter (where e.held),
           -- The sweep runs hourly, so the first deletion is at the next hour.
           'first_deletion_at', case when count(*) filter (where not e.held) > 0
                                     then date_trunc('hour', now()) + interval '1 hour' end)
    into result
    from retention.expired_objects(ws, p_scope, p_scope_id, p_hours) e;
  return result;
end
$$;

create function retention.set_policy(p_scope text, p_scope_id uuid, p_hours integer,
                                     p_confirm_slug text, p_basis text default 'upload')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  me uuid := core.current_user_id();
  est jsonb;
  ws_slug text;
  pid uuid;
  jid uuid;
  warn jsonb := '[]';
begin
  perform retention._require_admin();
  perform retention._check_scope(ws, p_scope, p_scope_id);
  if p_hours is not null and p_hours < 3 then
    raise exception 'RETENTION_MIN' using errcode = '22023';
  end if;
  if p_basis is null or p_basis not in ('upload', 'access') then
    raise exception 'INVALID_BASIS' using errcode = '22023';
  end if;
  est := retention.estimate(p_scope, p_scope_id, p_hours);
  select w.slug into ws_slug from core.workspace w where w.id = ws;
  if (est ->> 'total')::integer > 1000 and p_confirm_slug is distinct from ws_slug then
    raise exception 'CONFIRM_REQUIRED' using errcode = '22023';
  end if;

  insert into retention.policy (workspace_id, scope, scope_id, hours, basis, updated_by)
  values (ws, p_scope, p_scope_id, p_hours, p_basis, me)
  on conflict (workspace_id, scope, scope_id)
  do update set hours = excluded.hours, basis = excluded.basis, updated_by = me,
                updated_at = now()
  returning id into pid;

  insert into retention.deletion_job (workspace_id, kind, policy_id, status, estimate,
                                      scheduled_for, requested_by)
  values (ws, 'policy_change', pid, 'queued', est, (est ->> 'first_deletion_at')::timestamptz, me)
  returning id into jid;

  -- A policy too short for the 30-day lead gets one notice now instead of the countdown.
  if p_hours is not null and p_hours < 30 * 24 and p_scope in ('vault', 'matter') then
    select coalesce(jsonb_agg(jsonb_build_object(
             'vault_id', v.id, 'name', v.name, 'owner_id', v.owner_id,
             'matter_id', v.matter_id)), '[]')
      into warn
      from content.vault v
     where v.workspace_id = ws and v.deleted_at is null
       and ((p_scope = 'vault' and v.id = p_scope_id)
            or (p_scope = 'matter' and v.matter_id = p_scope_id));
  end if;

  perform retention._audit('user', 'retention.policy_changed', 'retention_policy', pid::text,
    jsonb_build_object('scope', p_scope, 'scope_id', p_scope_id, 'hours', p_hours,
                       'basis', p_basis, 'job_id', jid,
                       'estimate', est - 'first_deletion_at'));
  return jsonb_build_object('policy_id', pid, 'job_id', jid, 'estimate', est,
                            'warn_vaults', warn, 'admin_ids', to_jsonb(retention._admin_ids(ws)));
end
$$;

-- Back to inheriting: removes the row (and a vault's old hours) without deleting anything.
create function retention.clear_policy(p_scope text, p_scope_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  pid uuid;
  legacy boolean := false;
begin
  perform retention._require_admin();
  perform retention._check_scope(ws, p_scope, p_scope_id);
  delete from retention.policy p
   where p.workspace_id = ws and p.scope = p_scope and p.scope_id = p_scope_id
  returning p.id into pid;
  if p_scope = 'vault' then
    update content.vault v set retention_hours = null
     where v.id = p_scope_id and v.workspace_id = ws and v.retention_hours is not null;
    legacy := found;
  end if;
  if pid is null and not legacy then
    return false;
  end if;
  perform retention._audit('user', 'retention.policy_changed', 'retention_policy',
    coalesce(pid::text, p_scope_id::text),
    jsonb_build_object('scope', p_scope, 'scope_id', p_scope_id, 'cleared', true));
  return true;
end
$$;

-- Policies that are set, with the names an admin recognises. Vault and matter names are
-- shown to admins already (the vault list), and nothing else about them is.
create function retention.list_policies()
returns table (policy_id uuid, scope text, scope_id uuid, name text, hours integer, basis text,
               source text, updated_at timestamptz, updated_by uuid)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  ws uuid := core.current_workspace_id();
begin
  perform retention._require_admin();
  return query
    select p.id, p.scope, p.scope_id,
           case p.scope when 'workspace' then (select w.name from core.workspace w where w.id = ws)
                        when 'vault' then (select v.name from content.vault v where v.id = p.scope_id)
                        else (select m.matter_name from core.matter m where m.id = p.scope_id) end,
           p.hours, p.basis, 'policy'::text, p.updated_at, p.updated_by
      from retention.policy p where p.workspace_id = ws
    union all
    select null::uuid, 'vault'::text, v.id, v.name, v.retention_hours, 'upload'::text,
           'legacy'::text, v.updated_at, null::uuid
      from content.vault v
     where v.workspace_id = ws and v.retention_hours is not null and v.deleted_at is null
       and not exists (select 1 from retention.policy p
                        where p.workspace_id = ws and p.scope = 'vault' and p.scope_id = v.id)
     order by 2, 4;
end
$$;

create function retention.set_hold(p_object_type text, p_object_id uuid, p_held boolean,
                                   p_reason text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  me uuid := core.current_user_id();
  found_object boolean;
  changed boolean;
begin
  perform retention._require_admin();
  if p_object_type is null or p_object_type not in
       ('thread', 'document', 'vault', 'review_table', 'matter') then
    raise exception 'INVALID_SCOPE' using errcode = '22023';
  end if;
  found_object := case p_object_type
    when 'thread' then exists (select 1 from work.thread t
                                where t.id = p_object_id and t.workspace_id = ws)
    when 'document' then exists (select 1 from content.document d
                                  where d.id = p_object_id and d.workspace_id = ws)
    when 'vault' then exists (select 1 from content.vault v
                               where v.id = p_object_id and v.workspace_id = ws)
    when 'review_table' then exists (select 1 from work.review_table r
                                      where r.id = p_object_id and r.workspace_id = ws)
    else exists (select 1 from core.matter m where m.id = p_object_id and m.workspace_id = ws)
  end;
  if not found_object then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_held then
    if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
      raise exception 'INVALID_REASON' using errcode = '22023';
    end if;
    insert into retention.hold (workspace_id, object_type, object_id, reason, set_by)
    values (ws, p_object_type, p_object_id, btrim(p_reason), me)
    on conflict (workspace_id, object_type, object_id) do nothing;
  else
    delete from retention.hold h
     where h.workspace_id = ws and h.object_type = p_object_type and h.object_id = p_object_id;
  end if;
  changed := found;
  if changed then
    -- The reason is the admin's own words and may name a case, so it stays out of the trail.
    perform retention._audit('user', 'retention.hold_changed', p_object_type, p_object_id::text,
      jsonb_build_object('held', p_held));
  end if;
  return changed;
end
$$;

-- Removes one binned object for good and returns the stored files nothing points at any more.
create function retention._purge_item(p_bin uuid) returns bytea[]
language plpgsql security definer set search_path = '' as $$
declare
  b retention.recycle_bin;
  hashes bytea[] := '{}';
begin
  select * into b from retention.recycle_bin x
   where x.id = p_bin and x.workspace_id = core.current_workspace_id()
     and x.purged_at is null and x.restored_at is null for update;
  if b.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if b.object_type = 'thread' then
    delete from core.share_grant g
     where g.workspace_id = b.workspace_id and g.object_type = 'thread'
       and g.object_id = b.object_id;
    -- Messages, citations, attached versions, drafts, runs and their events cascade.
    delete from work.thread t where t.id = b.object_id and t.workspace_id = b.workspace_id;
  elsif b.object_type = 'review_table' then
    delete from core.share_grant g
     where g.workspace_id = b.workspace_id and g.object_type = 'review_table'
       and g.object_id = b.object_id;
    delete from work.review_table r where r.id = b.object_id and r.workspace_id = b.workspace_id;
  else
    select coalesce(array_agg(p.sha256), '{}') into hashes
      from content.purge(b.workspace_id, '{}', '{}', array[b.object_id]) p;
  end if;
  update retention.recycle_bin x set purged_at = now() where x.id = b.id;
  return hashes;
end
$$;

-- The sweep. One call from the worker moves what has expired into the bin, then empties
-- what has been there 30 days, one workspace at a time. Each object is its own step, so one
-- that fails is recorded in the job's report and tried again next time, and the rest go on.
create function retention.sweep_all() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ws record;
  obj record;
  item record;
  job uuid;
  failures jsonb;
  skipped integer;
  b_thread integer; b_doc integer; b_table integer;
  p_thread integer; p_doc integer; p_table integer;
  restored integer;
  live boolean;
  hashes bytea[];
  blobs bytea[];
  results jsonb := '[]';
  rep jsonb;
begin
  for ws in
    select w.id from core.workspace w
     where exists (select 1 from retention.policy p where p.workspace_id = w.id)
        or exists (select 1 from content.vault v
                    where v.workspace_id = w.id and v.retention_hours is not null)
        or exists (select 1 from retention.recycle_bin x
                    where x.workspace_id = w.id and x.purged_at is null and x.restored_at is null)
  loop
    perform set_config('app.user_id', '', true);
    perform set_config('app.workspace_id', ws.id::text, true);
    job := null; failures := '[]'; skipped := 0; restored := 0;
    b_thread := 0; b_doc := 0; b_table := 0; p_thread := 0; p_doc := 0; p_table := 0;
    blobs := '{}';
    begin
      for obj in select * from retention.expired_objects(ws.id) loop
        if obj.held then
          skipped := skipped + 1;
          continue;
        end if;
        begin
          if job is null then
            insert into retention.deletion_job (workspace_id, kind, status, started_at)
            values (ws.id, 'sweep', 'running', now()) returning id into job;
          end if;
          if obj.object_type = 'thread' then
            update work.thread t set deleted_at = now()
             where t.id = obj.object_id and t.deleted_at is null;
          elsif obj.object_type = 'review_table' then
            update work.review_table r set deleted_at = now()
             where r.id = obj.object_id and r.deleted_at is null;
          else
            -- The same reason a person's delete has, so the 30 days and the vault bin apply.
            update content.document d set deleted_at = now(), deleted_reason = 'user',
                                          updated_at = now()
             where d.id = obj.object_id and d.deleted_at is null;
          end if;
          if found then
            insert into retention.recycle_bin (workspace_id, object_type, object_id, label,
                                               policy_id, job_id, restorable_until)
            values (ws.id, obj.object_type, obj.object_id, left(obj.label, 255), obj.policy_id,
                    job, now() + interval '30 days');
            perform retention._audit('system', 'retention.object_binned', obj.object_type,
              obj.object_id::text,
              jsonb_build_object('policy_id', obj.policy_id, 'policy_scope', obj.policy_scope,
                                 'hours', obj.hours, 'job_id', job));
            if obj.object_type = 'thread' then b_thread := b_thread + 1;
            elsif obj.object_type = 'document' then b_doc := b_doc + 1;
            else b_table := b_table + 1; end if;
          end if;
        exception when others then
          failures := failures || jsonb_build_object('phase', 'bin',
            'object_type', obj.object_type, 'object_id', obj.object_id, 'code', sqlstate);
        end;
      end loop;

      for item in
        select x.* from retention.recycle_bin x
         where x.workspace_id = ws.id and x.purged_at is null and x.restored_at is null
           and x.restorable_until <= now()
         order by x.restorable_until limit 2000
      loop
        begin
          if retention._is_held(ws.id, item.object_type, item.object_id) then
            skipped := skipped + 1;
            continue;
          end if;
          if job is null then
            insert into retention.deletion_job (workspace_id, kind, status, started_at)
            values (ws.id, 'sweep', 'running', now()) returning id into job;
          end if;
          -- Someone brought it back by another route (the vault bin): it stays.
          live := case item.object_type
               when 'thread' then exists (select 1 from work.thread t
                                           where t.id = item.object_id and t.deleted_at is null)
               when 'review_table' then exists (select 1 from work.review_table r
                                                 where r.id = item.object_id
                                                   and r.deleted_at is null)
               else exists (select 1 from content.document d
                             where d.id = item.object_id and d.deleted_at is null) end;
          if live then
            update retention.recycle_bin x set restored_at = now() where x.id = item.id;
            restored := restored + 1;
            continue;
          end if;
          hashes := retention._purge_item(item.id);
          blobs := blobs || hashes;
          perform retention._audit('system', 'retention.object_purged', item.object_type,
            item.object_id::text, jsonb_build_object('job_id', job, 'bin_id', item.id));
          if item.object_type = 'thread' then p_thread := p_thread + 1;
          elsif item.object_type = 'document' then p_doc := p_doc + 1;
          else p_table := p_table + 1; end if;
        exception when others then
          failures := failures || jsonb_build_object('phase', 'purge',
            'object_type', item.object_type, 'object_id', item.object_id, 'code', sqlstate);
        end;
      end loop;

      -- Held objects are reported, but not every hour: once a day is enough.
      if job is null and skipped > 0 and not exists (
           select 1 from retention.deletion_job j
            where j.workspace_id = ws.id and j.kind = 'sweep'
              and j.created_at > now() - interval '24 hours') then
        insert into retention.deletion_job (workspace_id, kind, status, started_at)
        values (ws.id, 'sweep', 'running', now()) returning id into job;
      end if;

      if job is not null then
        rep := jsonb_build_object(
          'binned', jsonb_build_object('threads', b_thread, 'documents', b_doc,
                                       'review_tables', b_table),
          'purged', jsonb_build_object('threads', p_thread, 'documents', p_doc,
                                       'review_tables', p_table),
          'skipped_held', skipped, 'restored_elsewhere', restored,
          'files_released', cardinality(blobs), 'failures', failures);
        update retention.deletion_job j
           set status = case when jsonb_array_length(failures) > 0 then 'failed' else 'done' end,
               report = rep, finished_at = now()
         where j.id = job;
        if (b_thread + b_doc + b_table + p_thread + p_doc + p_table) > 0
           or jsonb_array_length(failures) > 0 then
          perform retention._audit('system', 'retention.sweep', null, null,
            jsonb_build_object('job_id', job, 'binned', b_thread + b_doc + b_table,
                               'purged', p_thread + p_doc + p_table,
                               'failures', jsonb_array_length(failures)));
        end if;
      end if;

      -- A saved change is carried out by this sweep.
      update retention.deletion_job j
         set status = 'done', started_at = coalesce(j.started_at, now()), finished_at = now(),
             report = jsonb_build_object('sweep_job_id', job)
       where j.workspace_id = ws.id and j.kind = 'policy_change' and j.status = 'queued';

      results := results || jsonb_build_object(
        'workspace_id', ws.id, 'job_id', job,
        'binned', b_thread + b_doc + b_table, 'purged', p_thread + p_doc + p_table,
        'skipped_held', skipped, 'failures', failures,
        'blobs', coalesce((select jsonb_agg(encode(h, 'hex')) from unnest(blobs) h), '[]'));
    exception when others then
      results := results || jsonb_build_object('workspace_id', ws.id, 'error', sqlstate,
                                               'binned', 0, 'purged', 0, 'blobs', '[]');
    end;
  end loop;
  perform set_config('app.workspace_id', '', true);
  return results;
end
$$;

create function retention.restore(p_bin uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  b retention.recycle_bin;
begin
  perform retention._require_admin();
  select * into b from retention.recycle_bin x
   where x.id = p_bin and x.workspace_id = ws for update;
  if b.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if b.purged_at is not null or b.restored_at is not null or b.restorable_until <= now() then
    raise exception 'NOT_RESTORABLE' using errcode = '22023';
  end if;
  -- The clock restarts, so the next sweep doesn't take it straight back.
  if b.object_type = 'thread' then
    update work.thread t set deleted_at = null, last_activity_at = now() where t.id = b.object_id;
  elsif b.object_type = 'review_table' then
    update work.review_table r set deleted_at = null, updated_at = now() where r.id = b.object_id;
  else
    if exists (select 1 from content.document d join content.vault v on v.id = d.vault_id
                where d.id = b.object_id and v.deleted_at is not null) then
      raise exception 'VAULT_DELETED' using errcode = '22023';
    end if;
    update content.document d
       set deleted_at = null, deleted_by = null, deleted_reason = null, updated_at = now(),
           folder_id = case when exists (select 1 from content.folder f
                                          where f.id = d.folder_id and f.deleted_at is not null)
                            then null else d.folder_id end
     where d.id = b.object_id;
  end if;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  update retention.recycle_bin x set restored_at = now() where x.id = b.id;
  perform retention._audit('user', 'recycle.restored', b.object_type, b.object_id::text,
    jsonb_build_object('bin_id', b.id, 'source', 'retention'));
  return jsonb_build_object('object_type', b.object_type, 'object_id', b.object_id);
end
$$;

-- An admin empties one item early. Held items stay.
create function retention.purge_now(p_bin uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  b retention.recycle_bin;
  hashes bytea[];
begin
  perform retention._require_admin();
  select * into b from retention.recycle_bin x
   where x.id = p_bin and x.workspace_id = ws
     and x.purged_at is null and x.restored_at is null;
  if b.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if retention._is_held(ws, b.object_type, b.object_id) then
    raise exception 'HELD' using errcode = '22023';
  end if;
  hashes := retention._purge_item(b.id);
  insert into retention.deletion_job (workspace_id, kind, status, report, started_at, finished_at,
                                      requested_by)
  values (ws, 'purge', 'done',
          jsonb_build_object('purged', 1, 'files_released', cardinality(hashes)),
          now(), now(), core.current_user_id());
  perform retention._audit('user', 'retention.object_purged', b.object_type, b.object_id::text,
    jsonb_build_object('bin_id', b.id, 'early', true));
  return jsonb_build_object('blobs', coalesce(
    (select jsonb_agg(encode(h, 'hex')) from unnest(hashes) h), '[]'), 'workspace_id', ws);
end
$$;

/*
 * Vaults whose content is about to expire under a vault or matter policy, one row per vault
 * and lead (30, 7, 1 days), each returned once. A policy shorter than the lead gets no such
 * warning: it was told at save. When several leads are already due only the nearest goes out.
 */
create function retention.due_warnings()
returns table (workspace_id uuid, vault_id uuid, vault_name text, owner_id uuid,
               matter_id uuid, lead_days integer, expires_at timestamptz, admin_ids uuid[])
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  ws record;
  v record;
  lead integer;
  l integer;
  newly boolean;
begin
  for ws in
    select w.id from core.workspace w
     where exists (select 1 from retention.policy p
                    where p.workspace_id = w.id and p.scope in ('vault', 'matter'))
        or exists (select 1 from content.vault x
                    where x.workspace_id = w.id and x.retention_hours is not null)
  loop
    perform set_config('app.user_id', '', true);
    perform set_config('app.workspace_id', ws.id::text, true);
    for v in
      select e.vault_id vid, min(e.expires_at) first_expiry,
             (array_agg(e.hours order by e.expires_at))[1] hrs
        from retention.expired_objects(ws.id, null, null, null, interval '30 days') e
       where e.object_type = 'document' and not e.held
         and e.policy_scope in ('vault', 'matter') and e.expires_at > now()
       group by e.vault_id
    loop
      lead := case when v.first_expiry <= now() + interval '1 day' then 1
                   when v.first_expiry <= now() + interval '7 days' then 7
                   else 30 end;
      -- Nearest lead only; the wider ones are marked so they never fire late.
      for l in select x from unnest(array[30, 7, 1]) x where x >= lead loop
        newly := false;
        if v.hrs >= l * 24 then
          insert into retention.warning_sent (workspace_id, vault_id, lead_days, expires_on)
          values (ws.id, v.vid, l, (v.first_expiry at time zone 'UTC')::date)
          on conflict do nothing;
          newly := found and l = lead;
        end if;
        if newly then
          return query
            select ws.id, x.id, x.name, x.owner_id, x.matter_id, l, v.first_expiry,
                   retention._admin_ids(ws.id)
              from content.vault x where x.id = v.vid;
        end if;
      end loop;
    end loop;
  end loop;
  perform set_config('app.workspace_id', '', true);
end
$$;

alter function retention._require_admin() owner to legallabs_definer;
alter function retention._check_scope(uuid, text, uuid) owner to legallabs_definer;
alter function retention._audit(text, text, text, text, jsonb) owner to legallabs_definer;
alter function retention._is_held(uuid, text, uuid) owner to legallabs_definer;
alter function retention._admin_ids(uuid) owner to legallabs_definer;
alter function retention.expired_objects(uuid, text, uuid, integer, interval)
  owner to legallabs_definer;
alter function retention.estimate(text, uuid, integer) owner to legallabs_definer;
alter function retention.set_policy(text, uuid, integer, text, text) owner to legallabs_definer;
alter function retention.clear_policy(text, uuid) owner to legallabs_definer;
alter function retention.list_policies() owner to legallabs_definer;
alter function retention.set_hold(text, uuid, boolean, text) owner to legallabs_definer;
alter function retention._purge_item(uuid) owner to legallabs_definer;
alter function retention.sweep_all() owner to legallabs_definer;
alter function retention.restore(uuid) owner to legallabs_definer;
alter function retention.purge_now(uuid) owner to legallabs_definer;
alter function retention.due_warnings() owner to legallabs_definer;

revoke execute on all functions in schema retention from public;
grant execute on function retention.estimate(text, uuid, integer),
  retention.set_policy(text, uuid, integer, text, text), retention.clear_policy(text, uuid),
  retention.list_policies(), retention.set_hold(text, uuid, boolean, text),
  retention.restore(uuid), retention.purge_now(uuid)
  to legallabs_app;
grant execute on function retention.sweep_all(), retention.due_warnings() to legallabs_worker;
