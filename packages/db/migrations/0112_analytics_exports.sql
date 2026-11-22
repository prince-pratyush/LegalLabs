-- Event exports: the file is built from raw events (the one place besides drill-downs that reads
-- analytics.usage_event), so the read, the job bookkeeping and the expiry sweep are definer
-- functions that check admin.reporting themselves. Prompt text is never part of an event.
create function analytics.export_events(
  p_from timestamptz,
  p_to timestamptz,
  p_surfaces text[],
  p_include_former boolean,
  p_after_at text,
  p_after_id uuid,
  p_limit integer
) returns table (
  cursor_at text, event_id uuid, timestamp_utc text, user_email text, user_status text,
  user_role text, groups text, access_point text, surface text, subsurface text, action text,
  action_class text, object_type text, object_id text, matter_ref text, source_kinds text,
  document_count integer, model text, input_tokens integer, output_tokens integer,
  cost_usd numeric, duration_ms integer
)
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
begin
  if not core.in_tenant(ws) or not core.has_permission('admin.reporting') then
    raise exception 'reporting is for admins' using errcode = '42501';
  end if;
  return query
  select e.at::text, e.id,
         to_char(e.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         u.email,
         case when u.kind = 'guest' then 'guest'
              when u.status in ('deprovisioned', 'suspended') then 'former'
              else 'active' end,
         coalesce(r.name, ''),
         coalesce((select string_agg(g.name, '|' order by g.name)
                     from core.group_member m
                     join core."group" g on g.workspace_id = m.workspace_id and g.id = m.group_id
                    where m.workspace_id = u.workspace_id and m.user_id = u.id), ''),
         e.access_point, e.surface, e.subsurface, e.action, e.action_class, e.object_type,
         e.object_id, e.matter_ref, array_to_string(e.source_kinds, '|'), e.document_count,
         e.model, e.input_tokens, e.output_tokens, e.cost_usd, e.duration_ms
    from analytics.usage_event e
    left join core."user" u on u.workspace_id = e.workspace_id and u.id = e.user_id
    left join core.role r on r.workspace_id = u.workspace_id and r.id = u.role_id
   where e.workspace_id = ws and e.at >= p_from and e.at < p_to
     and (p_surfaces is null or e.surface = any (p_surfaces))
     and (p_include_former or u.status not in ('deprovisioned', 'suspended'))
     and (p_after_at is null or (e.at, e.id) > (p_after_at::timestamptz, p_after_id))
   order by e.at, e.id
   limit greatest(p_limit, 1);
end
$$;

create function analytics.create_export_job(p_params jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  new_id uuid;
begin
  if not core.in_tenant(ws) or not core.has_permission('admin.reporting') then
    raise exception 'reporting is for admins' using errcode = '42501';
  end if;
  insert into analytics.export_job (workspace_id, requested_by, params, status)
  values (ws, core.current_user_id(), p_params, 'running')
  returning id into new_id;
  return new_id;
end
$$;

create function analytics.finish_export_job(
  p_id uuid, p_status text, p_row_count integer, p_key text, p_bytes bigint, p_gzip boolean,
  p_error text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
begin
  if not core.in_tenant(ws) or not core.has_permission('admin.reporting') then
    raise exception 'reporting is for admins' using errcode = '42501';
  end if;
  update analytics.export_job
     set status = p_status, row_count = p_row_count, storage_key = p_key, bytes = p_bytes,
         gzip = p_gzip, error = left(p_error, 500), finished_at = now(),
         expires_at = case when p_status = 'done' then now() + interval '7 days' end
   where id = p_id and workspace_id = ws;
end
$$;

-- Rows past their expiry (and failed ones a week old) go; the caller then deletes the files.
create function analytics.purge_expired_exports()
returns table (workspace_id uuid, id uuid, storage_key text)
language sql security definer set search_path = '' as $$
  delete from analytics.export_job j
   where j.expires_at < now() or (j.status = 'failed' and j.created_at < now() - interval '7 days')
  returning j.workspace_id, j.id, j.storage_key
$$;

alter function analytics.export_events(timestamptz, timestamptz, text[], boolean, text, uuid,
  integer) owner to legallabs_definer;
alter function analytics.create_export_job(jsonb) owner to legallabs_definer;
alter function analytics.finish_export_job(uuid, text, integer, text, bigint, boolean, text)
  owner to legallabs_definer;
alter function analytics.purge_expired_exports() owner to legallabs_definer;
grant execute on function
  analytics.export_events(timestamptz, timestamptz, text[], boolean, text, uuid, integer),
  analytics.create_export_job(jsonb),
  analytics.finish_export_job(uuid, text, integer, text, bigint, boolean, text)
  to legallabs_app;
grant execute on function analytics.purge_expired_exports() to legallabs_worker;
