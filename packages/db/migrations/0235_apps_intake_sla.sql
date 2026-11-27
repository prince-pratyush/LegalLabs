-- Intake over time: SLA state, escalations, silent requesters and merged requests. The sweep is
-- a due-queue; its functions take the time to judge against, so nothing here reads a clock to
-- decide what is late.

alter table apps.intake_request add column sla_state text not null default 'ok'
  check (sla_state in ('ok', 'at_risk', 'breached'));
alter table apps.intake_request add column awaiting_since timestamptz;
alter table apps.intake_request add column merged_into uuid;
alter table apps.intake_request add foreign key (workspace_id, merged_into)
  references apps.intake_request (workspace_id, id);
create index intake_request_merged_idx on apps.intake_request (merged_into)
  where merged_into is not null;
update apps.intake_request set awaiting_since = updated_at where status = 'awaiting_requester';
grant update (merged_into) on apps.intake_request to legallabs_app;

create table apps.intake_sweep (
  request_id uuid primary key,
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  due_at timestamptz not null default now(),
  foreign key (workspace_id, request_id) references apps.intake_request (workspace_id, id)
    on delete cascade
);
create index intake_sweep_due_idx on apps.intake_sweep (due_at);
insert into apps.intake_sweep (request_id, workspace_id)
select id, workspace_id from apps.intake_request where status not in ('done', 'closed');

-- Which escalations have fired, so each fires once for a request.
create table apps.intake_escalation (
  request_id uuid not null,
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  key text not null check (char_length(key) <= 100),
  fired_at timestamptz not null default now(),
  primary key (request_id, key),
  foreign key (workspace_id, request_id) references apps.intake_request (workspace_id, id)
    on delete cascade
);

create table apps.intake_watcher (
  request_id uuid not null,
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  user_id uuid not null,
  added_at timestamptz not null default now(),
  primary key (request_id, user_id),
  foreign key (workspace_id, request_id) references apps.intake_request (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);
create index intake_watcher_user_idx on apps.intake_watcher (user_id);

alter table apps.intake_sweep enable row level security;
alter table apps.intake_sweep force row level security;
alter table apps.intake_escalation enable row level security;
alter table apps.intake_escalation force row level security;
alter table apps.intake_watcher enable row level security;
alter table apps.intake_watcher force row level security;
grant select, insert, update, delete on apps.intake_sweep to legallabs_definer;
grant select, insert on apps.intake_escalation, apps.intake_watcher to legallabs_definer;
create policy definer_all on apps.intake_sweep for all to legallabs_definer
  using (true) with check (true);
create policy definer_all on apps.intake_escalation for all to legallabs_definer
  using (true) with check (true);
create policy definer_all on apps.intake_watcher for all to legallabs_definer
  using (true) with check (true);
grant select on apps.intake_watcher to legallabs_app;
create policy intake_watcher_read on apps.intake_watcher for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from apps.intake_request r where r.id = request_id));

grant update (assignee_id, updated_at) on work.task to legallabs_definer;
create policy intake_definer_update on work.task for update to legallabs_definer
  using (true) with check (assignee_type = 'user');

-- When a request started waiting on its requester, and what a merge may join. Both need the
-- old row, which policies cannot see.
create function apps.intake_request_times() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status <> 'awaiting_requester' then
    new.awaiting_since := null;
  elsif tg_op = 'INSERT' or old.status <> 'awaiting_requester' then
    new.awaiting_since := pg_catalog.now();
  end if;
  if tg_op = 'UPDATE' and new.merged_into is distinct from old.merged_into then
    -- The oldest is kept, and never across matters: its walls are not the other's.
    if old.merged_into is not null or new.status <> 'closed' or not exists (
         select 1 from apps.intake_request k
          where k.id = new.merged_into and k.workspace_id = new.workspace_id
            and k.number < new.number and k.status not in ('done', 'closed')
            and k.matter_id is not distinct from new.matter_id) then
      raise exception 'those requests cannot be merged' using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;
grant execute on function apps.intake_request_times() to legallabs_app, legallabs_definer;
create trigger intake_request_times before insert or update on apps.intake_request
  for each row execute function apps.intake_request_times();

-- Every change is looked at straight away, apart from the sweep's own. A finished request
-- stays queued until the sweep next meets it, and is dropped then.
create function apps.queue_intake_sweep() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status not in ('done', 'closed')
     and pg_catalog.current_setting('legallabs.intake_sweep', true) is distinct from 'on' then
    insert into apps.intake_sweep (request_id, workspace_id) values (new.id, new.workspace_id)
    on conflict (request_id) do update set due_at = pg_catalog.now();
  end if;
  return new;
end
$$;
create trigger intake_request_sweep
  after insert or update of status, assignee_id, type_id, fields, sla_due_at
  on apps.intake_request for each row execute function apps.queue_intake_sweep();

create function apps.intake_merged() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  kept apps.intake_request;
begin
  select * into kept from apps.intake_request r where r.id = new.merged_into;
  perform apps.intake_note(kept, 'merged', null,
    pg_catalog.jsonb_build_object('from', new.id));
  perform apps.intake_mail(new, 'merged', 'merged');
  return new;
end
$$;
create trigger intake_request_merged after update of merged_into on apps.intake_request
  for each row when (new.merged_into is not null) execute function apps.intake_merged();

-- Takes the next request to judge at `p_now`, and puts it off for a quarter of an hour. One
-- that has finished comes out of the queue instead, and is skipped.
create function apps.claim_intake_sweep(p_now timestamptz, p_workspaces uuid[] default null)
returns table (request_id uuid, workspace_id uuid, number integer, matter_id uuid,
               status text, fields jsonb, assignee_id uuid, created_at timestamptz,
               sla_due_at timestamptz, sla_state text, awaiting_since timestamptz,
               asked_field text, unsent boolean, timeout_hours integer, escalations jsonb)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  claimed uuid;
begin
  delete from apps.intake_sweep s
   using apps.intake_request r
   where r.id = s.request_id and r.status in ('done', 'closed')
     and (p_workspaces is null or s.workspace_id = any (p_workspaces));
  update apps.intake_sweep s set due_at = p_now + interval '15 minutes'
   where s.request_id = (
     select x.request_id from apps.intake_sweep x
      where x.due_at <= p_now
        and (p_workspaces is null or x.workspace_id = any (p_workspaces))
      order by x.due_at limit 1 for update skip locked)
  returning s.request_id into claimed;
  return query
    select r.id, r.workspace_id, r.number, r.matter_id, r.status, r.fields, r.assignee_id,
           r.created_at, r.sla_due_at, r.sla_state,
           -- An answer, even one that did not help, starts the wait again.
           case when r.awaiting_since is not null then greatest(r.awaiting_since,
             (select max(e.processed_at) from apps.inbound_email e where e.request_id = r.id))
           end,
           r.asked_field,
           -- Whether the latest question has yet to go out.
           coalesce((select o.status <> 'sent' from apps.intake_outbound o
                      where o.request_id = r.id and o.kind = 'ask'
                      order by o.created_at desc, o.id desc limit 1), false),
           coalesce(t.timeout_hours, 72), coalesce(t.escalations, '[]')
      from apps.intake_request r
      left join apps.intake_request_type t on t.id = r.type_id
     where r.id = claimed;
end
$$;

create function apps.set_intake_sla(p_request uuid, p_state text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  request apps.intake_request;
begin
  update apps.intake_request set sla_state = p_state
   where id = p_request and sla_state <> p_state and status not in ('done', 'closed')
  returning * into request;
  if request.id is null or p_state = 'ok' then
    return;
  end if;
  perform apps.intake_note(request, 'sla',
    case when p_state = 'breached' then 'intake.request.sla_breached' end,
    pg_catalog.jsonb_build_object('state', p_state));
end
$$;

-- Of a person, or a group's members, those who could open this request, the least busy first.
-- To take over its task they must also be able to hold that.
create function apps.intake_recipients(p_request apps.intake_request, p_user uuid,
                                       p_group uuid, p_for_task boolean)
returns uuid[]
language plpgsql volatile security definer set search_path = '' as $$
declare
  was_user text := coalesce(pg_catalog.current_setting('app.user_id', true), '');
  was_ws text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  space uuid;
  person uuid;
  found_ids uuid[] := '{}';
  ok boolean;
begin
  perform pg_catalog.set_config('app.workspace_id', p_request.workspace_id::text, true);
  select t.space_id into space from work.task t where t.id = p_request.task_id;
  for person in
    select u.id from core."user" u
     where u.workspace_id = p_request.workspace_id and u.status = 'active' and u.kind = 'member'
       and (u.id = p_user
            or exists (select 1 from core.group_member g
                        where g.group_id = p_group and g.user_id = u.id
                          and g.workspace_id = u.workspace_id))
     order by (select count(*) from apps.intake_request o
                where o.assignee_id = u.id and o.status not in ('done', 'closed')), u.id
     limit 50
  loop
    if p_for_task and space is not null then
      ok := apps.intake_eligible(person, p_request.matter_id, space);
    else
      perform pg_catalog.set_config('app.user_id', person::text, true);
      ok := apps.intake_may('intake.triage') and core.can_access_matter(p_request.matter_id);
      perform pg_catalog.set_config('app.user_id', was_user, true);
    end if;
    if ok then
      found_ids := found_ids || person;
    end if;
  end loop;
  perform pg_catalog.set_config('app.workspace_id', was_ws, true);
  return found_ids;
end
$$;

-- Fires one escalation of the request's type, once. Returns who to tell.
create function apps.fire_intake_escalation(p_request uuid, p_key text, p_action text,
                                            p_user uuid, p_group uuid) returns uuid[]
language plpgsql volatile security definer set search_path = '' as $$
declare
  request apps.intake_request;
  people uuid[];
begin
  select * into request from apps.intake_request r
   where r.id = p_request and r.status not in ('done', 'closed') for update;
  if request.id is null then
    return '{}';
  end if;
  insert into apps.intake_escalation (request_id, workspace_id, key)
  values (request.id, request.workspace_id, p_key) on conflict do nothing;
  if not found then
    return '{}';
  end if;
  people := apps.intake_recipients(request, p_user, p_group, p_action = 'reassign');
  if p_action = 'reassign' then
    people := people[1:1];
    if pg_catalog.cardinality(people) = 1 and people[1] is distinct from request.assignee_id
    then
      perform pg_catalog.set_config('legallabs.intake_sweep', 'on', true);
      update apps.intake_request set assignee_id = people[1], updated_at = pg_catalog.now()
       where id = request.id;
      perform pg_catalog.set_config('legallabs.intake_sweep', 'off', true);
      update work.task set assignee_id = people[1], updated_at = pg_catalog.now()
       where id = request.task_id and assignee_type = 'user'
         and status in ('todo', 'in_progress');
      perform apps.intake_note(request, 'assigned', 'intake.request.assigned',
        pg_catalog.jsonb_build_object('assignee_id', people[1]));
    end if;
  elsif p_action = 'add_watcher' then
    insert into apps.intake_watcher (request_id, workspace_id, user_id)
    select request.id, request.workspace_id, x from pg_catalog.unnest(people) x
    on conflict do nothing;
  end if;
  perform apps.intake_note(request, 'escalated', 'intake.request.escalated',
    pg_catalog.jsonb_build_object('action', p_action,
      'recipients', pg_catalog.cardinality(people)));
  return people;
end
$$;

-- Staff escalating by hand. Returns who to tell; nobody means nothing was recorded.
create function apps.escalate_intake_request(p_request uuid, p_user uuid, p_group uuid,
                                             p_note text) returns uuid[]
language plpgsql volatile security definer set search_path = '' as $$
declare
  request apps.intake_request;
  people uuid[];
begin
  select * into request from apps.intake_request r
   where r.id = p_request and r.workspace_id = core.current_workspace_id()
     and r.status not in ('done', 'closed') for update;
  if request.id is null or not apps.intake_may('intake.triage')
     or not core.can_access_matter(request.matter_id) then
    raise exception 'not allowed to escalate this request' using errcode = '42501';
  end if;
  people := apps.intake_recipients(request, p_user, p_group, false);
  if pg_catalog.cardinality(people) > 0 then
    insert into apps.intake_event (workspace_id, request_id, kind, actor_type, actor_id, details)
    values (request.workspace_id, request.id, 'escalated', 'user', core.current_user_id(),
      pg_catalog.jsonb_build_object('recipients', pg_catalog.cardinality(people),
        'note', pg_catalog.left(p_note, 500)));
  end if;
  return people;
end
$$;

create function apps.remind_intake_requester(p_request uuid, p_ref text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  request apps.intake_request;
begin
  select * into request from apps.intake_request r
   where r.id = p_request and r.status = 'awaiting_requester';
  if request.id is not null then
    perform apps.intake_mail(request, 'reminder', p_ref, request.asked_field);
  end if;
end
$$;

create function apps.expire_intake_request(p_request uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  request apps.intake_request;
begin
  select * into request from apps.intake_request r
   where r.id = p_request and r.status = 'awaiting_requester' for update;
  if request.id is null then
    return;
  end if;
  update apps.intake_request
     set status = 'closed', closed_reason = 'no_response', updated_at = pg_catalog.now()
   where id = request.id;
  perform apps.intake_note(request, 'status', 'intake.request.status_changed',
    pg_catalog.jsonb_build_object('from', request.status, 'to', 'closed'));
  perform apps.intake_mail(request, 'no_response', 'no_response');
end
$$;

-- As 0234, and an answer to a merged request goes to the one kept, when it is the same person.
create or replace function apps.append_inbound_reply(p_id uuid, p_lease uuid, p_email text,
                                                     p_tokens text[], p_attachments integer)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  message apps.inbound_email;
  request apps.intake_request;
begin
  select * into message from apps.inbound_email e
   where e.id = p_id and e.lease = p_lease and e.status = 'queued'
     and e.message_hash is not null for update;
  if message.id is null then
    return null;
  end if;
  select r.* into request
    from apps.intake_outbound o
    join apps.intake_request q on q.id = o.request_id
     and q.channel = 'email' and q.requester_email = p_email
    join apps.intake_request r on r.id = coalesce(q.merged_into, q.id)
     and r.channel = 'email' and r.requester_email = p_email
   where o.token = any (p_tokens) and o.workspace_id = message.workspace_id
     and r.status not in ('done', 'closed')
   order by o.created_at desc limit 1
   for update of r;
  if request.id is null then
    return null;
  end if;
  update apps.intake_attachment set request_id = request.id
   where inbound_email_id = p_id and request_id is null;
  insert into apps.intake_event (workspace_id, request_id, kind, actor_type, details)
  values (message.workspace_id, request.id, 'inbound', 'requester',
          pg_catalog.jsonb_build_object('channel', 'email', 'attachments', p_attachments));
  update apps.inbound_email
     set status = 'accepted', raw = null, lease = null, processed_at = pg_catalog.now(),
         request_id = request.id, attachment_count = p_attachments
   where id = p_id;
  perform apps.queue_intake_work(request.workspace_id, request.id);
  update apps.intake_sweep set due_at = pg_catalog.now() where request_id = request.id;
  return request.id;
end
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'apps.queue_intake_sweep()', 'apps.intake_merged()',
    'apps.claim_intake_sweep(timestamptz, uuid[])', 'apps.set_intake_sla(uuid, text)',
    'apps.intake_recipients(apps.intake_request, uuid, uuid, boolean)',
    'apps.fire_intake_escalation(uuid, text, text, uuid, uuid)',
    'apps.escalate_intake_request(uuid, uuid, uuid, text)',
    'apps.remind_intake_requester(uuid, text)', 'apps.expire_intake_request(uuid)']
  loop
    execute pg_catalog.format('alter function %s owner to legallabs_definer', fn);
    execute pg_catalog.format('revoke execute on function %s from public', fn);
  end loop;
end
$$;
grant execute on function apps.claim_intake_sweep(timestamptz, uuid[]),
  apps.set_intake_sla(uuid, text),
  apps.fire_intake_escalation(uuid, text, text, uuid, uuid),
  apps.remind_intake_requester(uuid, text), apps.expire_intake_request(uuid)
  to legallabs_worker;
grant execute on function apps.escalate_intake_request(uuid, uuid, uuid, text) to legallabs_app;
