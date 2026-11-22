-- A live guest's activity counts under their party (SPC-004), so usage recording accepts them too.
create or replace function analytics.record_usage(
  p_surface text,
  p_action text,
  p_action_class text,
  p_counter text default null,
  p_access_point text default 'web',
  p_subsurface text default null,
  p_object_type text default null,
  p_object_id text default null,
  p_matter_ref text default null,
  p_source_kinds text[] default '{}',
  p_document_count integer default 0,
  p_model text default null,
  p_input_tokens integer default null,
  p_output_tokens integer default null,
  p_cost_usd numeric default null,
  p_duration_ms integer default null,
  p_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  me uuid := core.current_user_id();
  new_id uuid;
begin
  if me is null or ws is null or not (core.in_tenant(ws) or core.is_active_guest()) then
    raise exception 'usage needs a signed-in member' using errcode = '42501';
  end if;
  insert into analytics.usage_event (workspace_id, at, user_id, access_point, surface, subsurface,
    action, action_class, counter, object_type, object_id, matter_ref, source_kinds,
    document_count, model, input_tokens, output_tokens, cost_usd, duration_ms)
  values (ws, coalesce(p_at, now()), me, p_access_point, p_surface, p_subsurface, p_action,
    p_action_class, p_counter, p_object_type, p_object_id, p_matter_ref,
    coalesce(p_source_kinds, '{}'), coalesce(p_document_count, 0), p_model, p_input_tokens,
    p_output_tokens, p_cost_usd, p_duration_ms)
  returning id into new_id;
  return new_id;
end
$$;
create or replace function analytics.record_outcome(
  p_workflow_type text,
  p_quantity integer default 1,
  p_turnaround_seconds integer default null,
  p_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := core.current_workspace_id();
  me uuid := core.current_user_id();
  base numeric;
  saved numeric;
  new_id uuid;
begin
  if me is null or ws is null or not (core.in_tenant(ws) or core.is_active_guest()) then
    raise exception 'outcome needs a signed-in member' using errcode = '42501';
  end if;
  select b.hours_per_completion into base
    from analytics.outcome_baseline b
   where b.workspace_id = ws and b.workflow_type = p_workflow_type;
  if base is null then
    base := case p_workflow_type
      when 'contract_reviewed' then 2.0
      when 'redline_applied' then 1.0
      when 'table_exported' then 0.1
      when 'draft_exported' then 1.5
      when 'research_memo_completed' then 4.0
      when 'request_resolved' then 0.5
      when 'chronology_generated' then 6.0
      when 'translation_completed' then 1.0
      when 'proofread_applied' then 0.5
    end;
  end if;
  if base is null then
    raise exception 'unknown workflow type' using errcode = '22023';
  end if;
  saved := case when p_workflow_type = 'table_exported'
                then least(base * greatest(p_quantity, 1), 40)
                else base end;
  insert into analytics.outcome_event (workspace_id, at, user_id, workflow_type, quantity,
    turnaround_seconds, baseline_hours, hours_saved)
  values (ws, coalesce(p_at, now()), me, p_workflow_type, greatest(p_quantity, 1),
    p_turnaround_seconds, base, saved)
  returning id into new_id;
  return new_id;
end
$$;