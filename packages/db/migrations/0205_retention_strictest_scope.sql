-- SEC-029 (06-security 5.5), finding F-16: the strictest applicable scope wins. Effective hours
-- are the shortest non-null of the workspace and (the matter if it has a policy, otherwise the
-- vault). Before this the most specific scope won, so a vault or matter could outlive the
-- workspace limit. Nothing stores an expiry, so the next sweep applies the new rule; what it
-- takes goes to the recycle bin for 30 days like any other retention deletion.

/*
 * Every live object whose time is up under the effective policy, or will be within p_horizon.
 * The estimate and the sweep both read this, so what an admin is shown is what is deleted.
 *
 * Effective hours: a matter's policy row replaces the vault's for that matter's files; what is
 * left is then cut to the workspace's hours. A row with no hours means that scope adds no limit,
 * and it never lifts the workspace's. A vault's old retention_hours counts as its vault policy
 * until a policy row replaces it. An object has at most one matter and one vault. p_scope,
 * p_scope_id and p_hours stand in for that scope's row, which is how the estimate looks at a
 * change before saving it. policy_id and policy_scope name the scope whose hours apply.
 *
 * Covered: threads, vault files, review tables. Never selected: library items and templates,
 * template files, audit events, usage events, daily analytics, matter records.
 */
create or replace function retention.expired_objects(
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
  ), scoped as (
    select c.*,
           case when mp.scope_id is not null then mp.hours else vp.hours end nhrs,
           case when mp.scope_id is not null then mp.id else vp.id end nid,
           case when mp.scope_id is not null then 'matter' else 'vault' end nscope,
           wp.hours whrs, wp.id wid
      from cand c
      left join pol mp on mp.scope = 'matter' and mp.scope_id = c.mid
      left join pol vp on vp.scope = 'vault' and vp.scope_id = c.vid
      left join pol wp on wp.scope = 'workspace' and wp.scope_id = p_workspace
  ), eff as (
    -- least() skips nulls, so an unlimited scope never lengthens the other.
    select s.*, least(s.nhrs, s.whrs) hrs,
           coalesce(s.nhrs <= s.whrs, s.nhrs is not null) narrow
      from scoped s
  )
  select e.ot, e.oid, e.vid, e.mid, e.lbl, e.b, e.hrs,
         e.b + make_interval(hours => e.hrs),
         case when e.narrow then e.nid else e.wid end,
         case when e.narrow then e.nscope else 'workspace' end,
         exists (select 1 from retention.hold h
                  where h.workspace_id = p_workspace
                    and ((h.object_type = e.ot and h.object_id = e.oid)
                         or (h.object_type = 'vault' and h.object_id = e.vid)
                         or (h.object_type = 'matter' and h.object_id = e.mid)))
    from eff e
   where e.hrs is not null and e.b + make_interval(hours => e.hrs) <= now() + p_horizon;
end
$$;

-- The listing now says what applies, not only what is set at the scope. For a vault in a matter
-- that has its own policy, the matter's hours stand in for the vault's.
drop function retention.list_policies();
create function retention.list_policies()
returns table (policy_id uuid, scope text, scope_id uuid, name text, hours integer, basis text,
               source text, updated_at timestamptz, updated_by uuid, effective_hours integer)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  ws uuid := core.current_workspace_id();
begin
  perform retention._require_admin();
  return query
    with listed as (
      select p.id, p.scope, p.scope_id,
             case p.scope when 'workspace' then (select w.name from core.workspace w where w.id = ws)
                          when 'vault' then (select v.name from content.vault v where v.id = p.scope_id)
                          else (select m.matter_name from core.matter m where m.id = p.scope_id)
             end as name,
             p.hours, p.basis, 'policy'::text as source, p.updated_at, p.updated_by
        from retention.policy p where p.workspace_id = ws
      union all
      select null::uuid, 'vault'::text, v.id, v.name, v.retention_hours, 'upload'::text,
             'legacy'::text, v.updated_at, null::uuid
        from content.vault v
       where v.workspace_id = ws and v.retention_hours is not null and v.deleted_at is null
         and not exists (select 1 from retention.policy p
                          where p.workspace_id = ws and p.scope = 'vault' and p.scope_id = v.id)
    )
    select l.id, l.scope, l.scope_id, l.name, l.hours, l.basis, l.source, l.updated_at,
           l.updated_by,
           least(case when mp.id is not null then mp.hours else l.hours end,
                 (select w.hours from retention.policy w
                   where w.workspace_id = ws and w.scope = 'workspace'))
      from listed l
      left join content.vault lv on l.scope = 'vault' and lv.id = l.scope_id
      left join retention.policy mp
        on mp.workspace_id = ws and mp.scope = 'matter' and mp.scope_id = lv.matter_id
     order by 2, 4;
end
$$;
alter function retention.list_policies() owner to legallabs_definer;
revoke execute on function retention.list_policies() from public;
grant execute on function retention.list_policies() to legallabs_app;

-- A vault or matter with its own policy that loses files to the shorter workspace limit is
-- still warned about, as it was when only its own hours applied.
create or replace function retention.due_warnings()
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
       where e.object_type = 'document' and not e.held and e.expires_at > now()
         and (e.policy_scope in ('vault', 'matter')
              or exists (select 1 from retention.policy p
                          where p.workspace_id = ws.id
                            and ((p.scope = 'vault' and p.scope_id = e.vault_id)
                                 or (p.scope = 'matter' and p.scope_id = e.matter_id)))
              or exists (select 1 from content.vault x
                          where x.id = e.vault_id and x.retention_hours is not null))
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

-- The older job deletes a vault's own files for good, so it must stand aside wherever that
-- setting no longer applies: a matter policy replaces it, and so does a vault policy row. The
-- sweep above covers those, through the bin. A restored file also counts from its restore, or
-- this job would remove for good what an admin had just brought back.
create or replace function content.sweep_vault_retention() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  ws record;
  doc record;
  moved integer;
  total integer := 0;
begin
  for ws in
    select v.workspace_id, array_agg(v.id) vaults
      from content.vault v
     where v.retention_hours is not null and v.deleted_at is null
     group by v.workspace_id
  loop
    perform set_config('app.user_id', '', true);
    perform set_config('app.workspace_id', ws.workspace_id::text, true);
    moved := 0;
    for doc in
      update content.document d
         set deleted_at = now(), deleted_reason = 'retention', updated_at = now()
        from content.vault v
       where v.id = d.vault_id and v.id = any (ws.vaults)
         and d.deleted_at is null
         and greatest(d.created_at, d.restored_at)
             < now() - make_interval(hours => v.retention_hours)
         and not exists (
               select 1 from retention.policy p
                where p.workspace_id = d.workspace_id
                  and ((p.scope = 'vault' and p.scope_id = v.id)
                       or (p.scope = 'matter'
                           and p.scope_id = coalesce(d.matter_id, v.matter_id))))
         and not retention._is_held(d.workspace_id, 'document', d.id)
      returning d.id, d.vault_id
    loop
      perform admin.append_audit_event('document.deleted', 'system', null, 'document',
        doc.id::text, jsonb_build_object('deleted_reason', 'retention', 'vault_id', doc.vault_id));
      moved := moved + 1;
    end loop;
    if moved > 0 then
      perform admin.append_audit_event('retention.sweep', 'system', null, null, null,
        jsonb_build_object('documents', moved, 'vaults', cardinality(ws.vaults)));
      total := total + moved;
    end if;
  end loop;
  perform set_config('app.workspace_id', '', true);
  return total;
end
$$;
