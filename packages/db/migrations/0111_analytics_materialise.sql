-- The materialiser: turns raw usage and outcome events into one analytics.daily row per UTC day.
-- Every six hours it recomputes the trailing 35 days (late events land); the first run backfills
-- 400. Members only: guests are counted apart as guest_activity. Former members stay in history.
-- Metric keys follow the Command Center spec: dau, mau, dau_mau, queries, queries_with_sources,
-- queries_without_sources, active_by_surface, per_user, outcomes, citations_*, practice_areas,
-- titles. Surfaces, practice areas and titles hold user ids so a range can count distinct people.
grant select on work.message, work.citation to legallabs_definer;
create policy definer_read on work.message for select to legallabs_definer using (true);
create policy definer_read on work.citation for select to legallabs_definer using (true);

create function analytics.materialise_workspace(p_ws uuid, p_from date, p_to date)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
  lo timestamptz := ((p_from - 29)::timestamp at time zone 'UTC');
  hi timestamptz := ((p_to + 1)::timestamp at time zone 'UTC');
begin
  with days as (
    select g::date as day from generate_series(p_from, p_to, interval '1 day') g
  ),
  ev as (
    select e.user_id, (e.at at time zone 'UTC')::date as day, e.surface, e.action_class,
           e.counter, e.source_kinds, e.document_count,
           coalesce(nullif(btrim(u.profile ->> 'practice_area'), ''), 'Unknown') as area,
           coalesce(nullif(btrim(u.profile ->> 'title'), ''), 'Unknown') as title
      from analytics.usage_event e
      join core."user" u on u.workspace_id = e.workspace_id and u.id = e.user_id
     where e.workspace_id = p_ws and u.kind = 'member' and e.at >= lo and e.at < hi
  ),
  guests as (
    select (e.at at time zone 'UTC')::date as day, count(*) as n
      from analytics.usage_event e
      join core."user" u on u.workspace_id = e.workspace_id and u.id = e.user_id
     where e.workspace_id = p_ws and u.kind = 'guest' and e.action_class = 'query'
       and e.at >= lo and e.at < hi
     group by 1
  ),
  oc as (
    select (o.at at time zone 'UTC')::date as day, o.workflow_type,
           count(*) as completions,
           percentile_cont(0.5) within group (order by o.turnaround_seconds) as p50,
           sum(o.hours_saved) as saved
      from analytics.outcome_event o
      join core."user" u on u.workspace_id = o.workspace_id and u.id = o.user_id
     where o.workspace_id = p_ws and u.kind = 'member' and o.at >= lo and o.at < hi
     group by 1, 2
  ),
  ci as (
    select (m.created_at at time zone 'UTC')::date as day,
           count(*) filter (where c.status = 'ok') as ok,
           count(*) filter (where c.status <> 'ok') as flagged
      from work.citation c
      join work.message m on m.workspace_id = c.workspace_id and m.id = c.message_id
     where c.workspace_id = p_ws and m.created_at >= lo and m.created_at < hi
     group by 1
  )
  insert into analytics.daily (workspace_id, day, metrics, materialised_at)
  select p_ws, d.day,
    jsonb_build_object(
      'dau', s.dau, 'mau', s.mau,
      'dau_mau', case when s.mau = 0 then 0 else round(s.dau::numeric / s.mau, 6) end,
      'queries', s.queries, 'queries_with_sources', s.with_sources,
      'queries_without_sources', s.queries - s.with_sources,
      'active_by_surface', coalesce((
        select jsonb_object_agg(x.surface, x.users) from (
          select surface, jsonb_agg(distinct user_id) as users from ev
           where ev.day = d.day and action_class = 'query' group by surface) x), '{}'),
      'per_user', coalesce((
        select jsonb_object_agg(x.user_id, x.m) from (
          select user_id, jsonb_build_object(
            'active', (count(*) filter (where action_class = 'query') > 0)::int,
            'threads', count(*) filter (where counter = 'threads'),
            'follow_ups', count(*) filter (where counter = 'follow_ups'),
            'agent_runs', count(*) filter (where counter = 'agent_runs'),
            'playbook_runs', count(*) filter (where counter = 'playbook_runs'),
            'rt_columns', count(*) filter (where counter = 'rt_columns'),
            'word', count(*) filter (where counter = 'word'),
            'outlook', count(*) filter (where counter = 'outlook')) as m
            from ev where ev.day = d.day group by user_id) x), '{}'),
      'outcomes', coalesce((
        select jsonb_object_agg(oc.workflow_type, jsonb_build_object(
          'count', oc.completions, 'turnaround_p50', oc.p50, 'hours_saved', oc.saved))
          from oc where oc.day = d.day), '{}'),
      'citations_verified', coalesce((select ci.ok from ci where ci.day = d.day), 0),
      'citations_flagged', coalesce((select ci.flagged from ci where ci.day = d.day), 0),
      'practice_areas', coalesce((
        select jsonb_object_agg(x.area, jsonb_build_object('users', x.users, 'queries', x.q))
          from (select area, jsonb_agg(distinct user_id) as users, count(*) as q from ev
                 where ev.day = d.day and action_class = 'query' group by area) x), '{}'),
      'titles', coalesce((
        select jsonb_object_agg(x.title, jsonb_build_object('users', x.users, 'queries', x.q))
          from (select title, jsonb_agg(distinct user_id) as users, count(*) as q from ev
                 where ev.day = d.day and action_class = 'query' group by title) x), '{}'),
      'guest_activity', coalesce((select g.n from guests g where g.day = d.day), 0)),
    now()
    from days d
   cross join lateral (
     select (select count(distinct user_id) from ev
              where ev.day = d.day and action_class = 'query') as dau,
            (select count(distinct user_id) from ev
              where action_class = 'query' and ev.day between d.day - 29 and d.day) as mau,
            (select count(*) from ev
              where ev.day = d.day and action_class = 'query') as queries,
            (select count(*) from ev
              where ev.day = d.day and action_class = 'query'
                and (cardinality(source_kinds) > 0 or document_count > 0)) as with_sources) s
  on conflict (workspace_id, day)
  do update set metrics = excluded.metrics, materialised_at = excluded.materialised_at;
  get diagnostics n = row_count;
  insert into analytics.refresh_state (workspace_id, materialised_at)
  values (p_ws, now())
  on conflict (workspace_id) do update set materialised_at = excluded.materialised_at;
  return n;
end
$$;

-- The six-hourly run, for the worker. A workspace never materialised before gets the backfill.
create function analytics.materialise_all(p_backfill_days integer default 400,
                                          p_window_days integer default 35)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  ws record;
  today date := (now() at time zone 'UTC')::date;
  total integer := 0;
begin
  for ws in
    select w.id, s.materialised_at
      from core.workspace w left join analytics.refresh_state s on s.workspace_id = w.id
  loop
    total := total + analytics.materialise_workspace(
      ws.id,
      today - (case when ws.materialised_at is null then p_backfill_days else p_window_days end),
      today);
  end loop;
  return total;
end
$$;

-- An admin asks for a refresh now; at most one an hour.
create function analytics.request_refresh() returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  today date := (now() at time zone 'UTC')::date;
  st record;
begin
  if not core.in_tenant(ws) or not core.has_permission('admin.reporting') then
    raise exception 'reporting is for admins' using errcode = '42501';
  end if;
  select * into st from analytics.refresh_state where workspace_id = ws for update;
  if st.requested_at is not null and st.requested_at > now() - interval '1 hour' then
    raise exception 'REFRESH_TOO_SOON' using errcode = 'P0001';
  end if;
  perform analytics.materialise_workspace(
    ws, today - (case when st.materialised_at is null then 400 else 35 end), today);
  update analytics.refresh_state set requested_at = now() where workspace_id = ws;
  return now();
end
$$;

alter function analytics.materialise_workspace(uuid, date, date) owner to legallabs_definer;
alter function analytics.materialise_all(integer, integer) owner to legallabs_definer;
alter function analytics.request_refresh() owner to legallabs_definer;
grant execute on function analytics.materialise_all(integer, integer) to legallabs_worker;
grant execute on function analytics.request_refresh() to legallabs_app;
