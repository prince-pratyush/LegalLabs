-- Phases group a Space's tasks in order. A gate task, once approved, unlocks the next phase.
create table work.phase (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  space_id uuid not null,
  ordinal integer not null check (ordinal >= 1),
  name text not null check (char_length(name) between 1 and 120),
  -- Set when an admin opens the next phase without waiting for approvals.
  locked_override boolean not null default false,
  created_at timestamptz not null default now(),
  unique (space_id, id),
  unique (workspace_id, id),
  -- Deferred, so reordering can swap two numbers inside one transaction.
  unique (space_id, ordinal) deferrable initially deferred,
  foreign key (workspace_id, space_id) references work.space (workspace_id, id) on delete cascade
);

create table work.task (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  space_id uuid not null,
  phase_id uuid,
  name text not null check (char_length(name) between 1 and 200),
  description_md text not null default '' check (char_length(description_md) <= 10000),
  -- A person, the assistant (no id) or an agent.
  assignee_type text check (assignee_type in ('user', 'assistant', 'agent')),
  assignee_id uuid,
  created_by uuid not null,
  due_at date,
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done', 'cancelled')),
  awaiting_approval boolean not null default false,
  gate boolean not null default false,
  -- {resources: [{resource_type, resource_id}], outputs: [{kind, id}]}
  linked jsonb not null default '{"resources": [], "outputs": []}'
    check (jsonb_typeof(linked) = 'object'),
  -- The latest run for an assigned task. Kept as plain ids: runs are owned by the run engine.
  run_id uuid,
  thread_id uuid,
  approved_by uuid,
  approved_at timestamptz,
  cancelled_reason text check (char_length(cancelled_reason) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((assignee_type is null and assignee_id is null)
      or (assignee_type = 'assistant' and assignee_id is null)
      or (assignee_type in ('user', 'agent') and assignee_id is not null)),
  check (not awaiting_approval or (gate and status = 'in_progress')),
  foreign key (workspace_id, space_id) references work.space (workspace_id, id) on delete cascade,
  foreign key (space_id, phase_id) references work.phase (space_id, id) on delete set null (phase_id),
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id)
);
create index task_phase_idx on work.task (space_id, phase_id, status);
create index task_assignee_idx on work.task (assignee_id, status) where assignee_type = 'user';
create index task_run_idx on work.task (run_id) where run_id is not null;

create table work.task_comment (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null,
  space_id uuid not null,
  task_id uuid not null,
  author_type text not null default 'user' check (author_type in ('user', 'assistant')),
  author_id uuid,
  body_md text not null check (char_length(body_md) <= 5000),
  mentions uuid[] not null default '{}' check (cardinality(mentions) <= 20),
  attachments jsonb not null default '[]' check (jsonb_typeof(attachments) = 'array'),
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, task_id) references work.task (workspace_id, id) on delete cascade,
  foreign key (workspace_id, space_id) references work.space (workspace_id, id) on delete cascade
);
create index task_comment_idx on work.task_comment (task_id, created_at, id);

grant select on work.phase, work.task to legallabs_definer;
create policy definer_read on work.phase for select to legallabs_definer using (true);
create policy definer_read on work.task for select to legallabs_definer using (true);

-- A phase is locked while the one before it holds a gate task that is neither approved nor
-- cancelled, unless an admin opened it. The first phase never locks.
create function work.phase_locked(p_phase uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select not ph.locked_override and exists (
      select 1 from work.phase prev
        join work.task t on t.space_id = prev.space_id and t.phase_id = prev.id
       where prev.space_id = ph.space_id
         and prev.ordinal = (select max(p.ordinal) from work.phase p
                              where p.space_id = ph.space_id and p.ordinal < ph.ordinal)
         and t.gate and t.status <> 'cancelled' and t.approved_at is null)
      from work.phase ph where ph.id = p_phase), false)
$$;
alter function work.phase_locked(uuid) owner to legallabs_definer;
grant execute on function work.phase_locked(uuid) to legallabs_app, legallabs_definer;

-- The rules a client must not be able to skip, whatever route the update takes.
create function work.guard_task() returns trigger
language plpgsql as $$
declare
  role text;
begin
  new.updated_at := now();
  if current_user <> 'legallabs_app' then
    return new;
  end if;
  role := work.space_role(new.space_id);
  if tg_op = 'INSERT' then
    if new.gate and role <> 'admin' then
      raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if (new.gate, new.approved_by, new.approved_at) is distinct from (old.gate, old.approved_by, old.approved_at)
     and role <> 'admin' then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  if new.status is distinct from old.status then
    if old.phase_id is not null and work.phase_locked(old.phase_id) then
      raise exception 'PHASE_LOCKED' using errcode = 'check_violation';
    end if;
    -- An approved task is reopened only by an admin.
    if old.status = 'done' and old.approved_at is not null and role <> 'admin' then
      raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
    end if;
    -- A gate closes through approval; an admin finishing it is the approval.
    if new.status = 'done' and new.gate and new.approved_at is null then
      raise exception 'GATE_NEEDS_APPROVAL' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;
create trigger task_guard before insert or update on work.task
  for each row execute function work.guard_task();

alter table work.phase enable row level security;
alter table work.phase force row level security;
alter table work.task enable row level security;
alter table work.task force row level security;
alter table work.task_comment enable row level security;
alter table work.task_comment force row level security;

grant select, insert, update, delete on work.phase to legallabs_app;
create policy phase_read on work.phase for select to legallabs_app
  using (core.in_tenant(workspace_id) and work.space_role(space_id) is not null);
create policy phase_write on work.phase for all to legallabs_app
  using (core.in_tenant(workspace_id) and work.space_role(space_id) = 'admin')
  with check (core.in_tenant(workspace_id) and work.space_role(space_id) = 'admin');

-- Tasks are never deleted; a cancelled one stays as a record.
grant select, insert, update on work.task to legallabs_app;
create policy task_read on work.task for select to legallabs_app
  using (core.in_tenant(workspace_id) and work.space_role(space_id) is not null);
create policy task_insert on work.task for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and created_by = core.current_user_id()
              and work.space_role(space_id) in ('admin', 'collaborator'));
create policy task_update on work.task for update to legallabs_app
  using (core.in_tenant(workspace_id) and work.space_role(space_id) in ('admin', 'collaborator'))
  with check (core.in_tenant(workspace_id) and work.space_role(space_id) in ('admin', 'collaborator'));

grant select, insert, update on work.task_comment to legallabs_app;
create policy comment_read on work.task_comment for select to legallabs_app
  using (core.in_tenant(workspace_id) and work.space_role(space_id) is not null);
create policy comment_insert on work.task_comment for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and work.space_role(space_id) in ('admin', 'collaborator')
              and (author_type = 'assistant' or author_id = core.current_user_id()));
-- Authors edit or tombstone their own; admins can tombstone anyone's.
create policy comment_update on work.task_comment for update to legallabs_app
  using (core.in_tenant(workspace_id)
         and (author_id = core.current_user_id() or work.space_role(space_id) = 'admin'))
  with check (core.in_tenant(workspace_id) and work.space_role(space_id) in ('admin', 'collaborator'));
