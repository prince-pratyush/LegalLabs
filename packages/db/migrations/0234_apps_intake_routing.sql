-- Classifying, completing and routing intake requests, and the mail that goes back. The worker
-- has no identity: each function here does one thing and takes the workspace from the row.

alter table apps.intake_request add column classification_confidence real
  check (classification_confidence between 0 and 1);
alter table apps.intake_request add column task_id uuid;
alter table apps.intake_request add column asked_field text;
create index intake_request_task_idx on apps.intake_request (task_id) where task_id is not null;

-- Routing runs on the say of whoever last set it, and only while they still could.
alter table apps.intake_request_type add column routing_by uuid;
update apps.intake_request_type set routing_by = created_by where routing is not null;

create function apps.stamp_intake_routing() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'legallabs_app' then
    new.routing_by := case when tg_op = 'UPDATE' and new.routing is not distinct from old.routing
                           then old.routing_by else core.current_user_id() end;
  end if;
  return new;
end
$$;
grant execute on function apps.stamp_intake_routing() to legallabs_app;
create trigger intake_routing_stamp before insert or update on apps.intake_request_type
  for each row execute function apps.stamp_intake_routing();

-- One row per request that has something to be done to it. `due_at` null means nothing has.
create table apps.intake_work (
  request_id uuid primary key,
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  due_at timestamptz default now(),
  attempts integer not null default 0,
  -- Model calls spent on this request, in its life.
  calls integer not null default 0,
  lease uuid,
  foreign key (workspace_id, request_id) references apps.intake_request (workspace_id, id)
    on delete cascade
);
create index intake_work_due_idx on apps.intake_work (due_at) where due_at is not null;

-- Mail to a requester: queued here, sent once, and the words dropped once it has gone. The
-- token goes out in the Message-ID, so an answer can be matched to its request.
create table apps.intake_outbound (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  request_id uuid not null,
  kind text not null check (kind in
    ('ask', 'assigned', 'done', 'reply', 'reminder', 'no_response', 'merged')),
  -- What it is about, so the same thing is never queued twice.
  ref text not null check (char_length(ref) between 1 and 200),
  field text check (char_length(field) <= 60),
  body text check (char_length(body) <= 5000),
  token text not null default pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
    unique,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  check (body is null or (kind = 'reply' and status = 'queued')),
  unique (request_id, ref),
  foreign key (workspace_id, request_id) references apps.intake_request (workspace_id, id)
    on delete cascade
);
create index intake_outbound_due_idx on apps.intake_outbound (next_attempt_at)
  where status = 'queued';
create index intake_outbound_claimed_idx on apps.intake_outbound (workspace_id, claimed_at);

alter table apps.intake_work enable row level security;
alter table apps.intake_work force row level security;
alter table apps.intake_outbound enable row level security;
alter table apps.intake_outbound force row level security;

grant select, insert, update on apps.intake_work, apps.intake_outbound to legallabs_definer;
create policy definer_all on apps.intake_work for all to legallabs_definer
  using (true) with check (true);
create policy definer_all on apps.intake_outbound for all to legallabs_definer
  using (true) with check (true);

-- Triage staff queue a reply to a request they can see. Nothing else is theirs to write.
grant select, insert on apps.intake_outbound to legallabs_app;
create policy intake_outbound_read on apps.intake_outbound for select to legallabs_app
  using (core.in_tenant(workspace_id)
         and exists (select 1 from apps.intake_request r where r.id = request_id));
create policy intake_outbound_reply on apps.intake_outbound for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and kind = 'reply' and status = 'queued'
              and field is null and created_by = core.current_user_id()
              and exists (select 1 from apps.intake_request r
                           where r.id = request_id and r.channel = 'email'
                             and r.status not in ('done', 'closed')));

grant select on apps.intake_request_type, apps.intake_event to legallabs_definer;
grant update on apps.intake_request to legallabs_definer;
grant insert on work.task to legallabs_definer;
grant execute on function work.user_in_space(uuid, uuid) to legallabs_definer;
create policy intake_definer_read on apps.intake_request_type for select to legallabs_definer
  using (true);
create policy intake_definer_read on apps.intake_event for select to legallabs_definer
  using (true);
create policy intake_definer_update on apps.intake_request for update to legallabs_definer
  using (true) with check (true);
create policy intake_definer_system on apps.intake_event for insert to legallabs_definer
  with check (actor_type in ('system', 'user'));
create policy intake_definer_insert on work.task for insert to legallabs_definer
  with check (assignee_type = 'user');

create function apps.queue_intake_work(p_workspace uuid, p_request uuid) returns void
language sql volatile security definer set search_path = '' as $$
  insert into apps.intake_work as w (request_id, workspace_id)
  values (p_request, p_workspace)
  on conflict (request_id) do update set due_at = pg_catalog.now(), attempts = 0, lease = null
$$;

-- Mail is always looked at; a request typed in by staff once it has a type.
create function apps.intake_request_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (tg_op = 'INSERT' and (new.channel = 'email' or new.type_id is not null))
     or (tg_op = 'UPDATE' and new.type_id is distinct from old.type_id
         and pg_catalog.current_setting('legallabs.intake_worker', true) is distinct from 'on')
  then
    perform apps.queue_intake_work(new.workspace_id, new.id);
  end if;
  return new;
end
$$;
create trigger intake_request_queue after insert or update of type_id on apps.intake_request
  for each row execute function apps.intake_request_changed();

create function apps.intake_note(p_request apps.intake_request, p_kind text, p_action text,
                                 p_details jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  was text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
begin
  insert into apps.intake_event (workspace_id, request_id, kind, actor_type, details)
  values (p_request.workspace_id, p_request.id, p_kind, 'system', p_details);
  if p_action is not null then
    perform pg_catalog.set_config('app.workspace_id', p_request.workspace_id::text, true);
    perform admin.append_audit_event(p_action, 'system', null, 'intake_request',
      p_request.id::text, p_details);
    perform pg_catalog.set_config('app.workspace_id', was, true);
  end if;
end
$$;

-- Queues mail to an email requester, once per `p_ref`.
create function apps.intake_mail(p_request apps.intake_request, p_kind text, p_ref text,
                                 p_field text default null) returns void
language sql volatile security definer set search_path = '' as $$
  insert into apps.intake_outbound (workspace_id, request_id, kind, ref, field)
  select p_request.workspace_id, p_request.id, p_kind, p_ref, p_field
   where p_request.channel = 'email' and p_request.requester_email is not null
  on conflict (request_id, ref) do nothing
$$;

-- The next request to look at, with what is needed to read it. The message itself is found by
-- its hash in the object store: the latest one received for the request.
create function apps.claim_intake_work(p_lease_seconds integer,
                                       p_workspaces uuid[] default null)
returns table (request_id uuid, workspace_id uuid, lease uuid, attempt integer, calls integer,
               channel text, status text, type_id uuid, fields jsonb, asked_field text,
               message_sha256 bytea, attachment_id uuid, types jsonb)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  claimed uuid;
begin
  update apps.intake_work w
     set attempts = w.attempts + 1, lease = pg_catalog.gen_random_uuid(),
         due_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds)
   where w.request_id = (
     select x.request_id from apps.intake_work x
      where x.due_at <= pg_catalog.now()
        and (p_workspaces is null or x.workspace_id = any (p_workspaces))
      order by x.due_at limit 1 for update skip locked)
  returning w.request_id into claimed;
  return query
    select r.id, r.workspace_id, w.lease, w.attempts, w.calls, r.channel, r.status, r.type_id,
           r.fields, r.asked_field,
           (select v.sha256
              from apps.inbound_email e
              join apps.intake_attachment a on a.inbound_email_id = e.id and a.part_no = 0
              join content.document d on d.id = a.document_id and d.deleted_at is null
              join content.document_version v on v.document_id = d.id and v.version_no = 1
             where e.request_id = r.id
             order by e.received_at desc, e.id desc limit 1),
           (select a.document_id from apps.intake_attachment a
             where a.request_id = r.id and coalesce(a.part_no, 1) > 0
             order by a.created_at, a.part_no limit 1),
           (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                     'id', t.id, 'name', t.name, 'description', t.description,
                     'fields', t.fields, 'keyword_rules', t.keyword_rules,
                     'routing', t.routing, 'default_owners', t.default_owners)
                     order by pg_catalog.lower(t.name)), '[]')
              from apps.intake_request_type t
             where t.workspace_id = r.workspace_id and t.deleted_at is null)
      from apps.intake_work w
      join apps.intake_request r on r.id = w.request_id
     where w.request_id = claimed;
end
$$;

-- Counted before the model is called, so a crash cannot spend without end.
create function apps.spend_intake_call(p_request uuid, p_lease uuid) returns void
language sql volatile security definer set search_path = '' as $$
  update apps.intake_work set calls = calls + 1
   where request_id = p_request and lease = p_lease
$$;

create function apps.postpone_intake_work(p_request uuid, p_lease uuid, p_seconds integer)
returns void
language sql volatile security definer set search_path = '' as $$
  update apps.intake_work
     set due_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_seconds), lease = null
   where request_id = p_request and lease = p_lease
$$;

-- Whether this person could be given this request in this Space, asked as them.
create function apps.intake_eligible(p_user uuid, p_matter uuid, p_space uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  was text := coalesce(pg_catalog.current_setting('app.user_id', true), '');
  ok boolean;
begin
  perform pg_catalog.set_config('app.user_id', p_user::text, true);
  ok := apps.intake_may('intake.triage') and core.can_access_matter(p_matter)
        and coalesce(work.space_membership(p_space) in ('admin', 'collaborator'), false)
        and work.user_in_space(p_space, p_user);
  perform pg_catalog.set_config('app.user_id', was, true);
  return coalesce(ok, false);
end
$$;

-- Gives a complete request to a lawyer, as a task in the type's Space. The task carries the
-- number and the type's name only: nothing the requester wrote leaves the request.
-- `p_candidates` is who to try, in order, as {user_id} or {group_id}.
create function apps.route_intake_request(p_request uuid, p_candidates jsonb) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  was_ws text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  was_user text := coalesce(pg_catalog.current_setting('app.user_id', true), '');
  request apps.intake_request;
  kind apps.intake_request_type;
  space uuid;
  candidate jsonb;
  chosen uuid;
  task uuid;
  allowed boolean;
begin
  select * into request from apps.intake_request r where r.id = p_request for update;
  if request.id is null or request.task_id is not null
     or request.status not in ('new', 'unclassified', 'awaiting_requester', 'triaged') then
    return null;
  end if;
  select * into kind from apps.intake_request_type t
   where t.id = request.type_id and t.workspace_id = request.workspace_id
     and t.deleted_at is null;
  if kind.routing ->> 'kind' is distinct from 'lawyer' then
    return null;
  end if;
  space := (kind.routing ->> 'space_id')::uuid;
  perform pg_catalog.set_config('app.workspace_id', request.workspace_id::text, true);
  perform pg_catalog.set_config('app.user_id', kind.routing_by::text, true);
  allowed := (apps.intake_may('intake.manage') or apps.intake_may('admin.config'))
             and coalesce(work.space_role(space) in ('admin', 'collaborator'), false)
             and exists (select 1 from work.space s
                          where s.id = space and s.deleted_at is null
                            and s.workspace_id = request.workspace_id);
  perform pg_catalog.set_config('app.user_id', was_user, true);
  if coalesce(allowed, false) then
    for candidate in select value from pg_catalog.jsonb_array_elements(p_candidates)
    loop
      -- Of a group's members, whoever has the fewest open requests.
      select u.id into chosen
        from core."user" u
       where u.workspace_id = request.workspace_id and u.status = 'active' and u.kind = 'member'
         and (u.id = (candidate ->> 'user_id')::uuid
              or exists (select 1 from core.group_member g
                          where g.group_id = (candidate ->> 'group_id')::uuid
                            and g.user_id = u.id and g.workspace_id = u.workspace_id))
         and apps.intake_eligible(u.id, request.matter_id, space)
       order by (select count(*) from apps.intake_request o
                  where o.assignee_id = u.id and o.status not in ('done', 'closed')), u.id
       limit 1;
      exit when chosen is not null;
    end loop;
  end if;
  if chosen is null then
    perform apps.intake_note(request, 'routed', 'intake.request.routed',
      pg_catalog.jsonb_build_object('kind', 'lawyer', 'outcome',
        case when coalesce(allowed, false) then 'no_assignee' else 'not_allowed' end));
    perform pg_catalog.set_config('app.workspace_id', was_ws, true);
    return null;
  end if;
  insert into work.task (workspace_id, space_id, name, description_md, assignee_type,
    assignee_id, created_by, due_at)
  values (request.workspace_id, space,
    pg_catalog.left('Intake request #' || request.number || ': ' || kind.name, 200),
    'Open the request: #/intake/requests/' || request.id::text, 'user', chosen,
    kind.routing_by, request.sla_due_at::date)
  returning id into task;
  update apps.intake_request
     set status = 'in_progress', assignee_id = chosen, task_id = task, asked_field = null,
         updated_at = pg_catalog.now()
   where id = request.id;
  perform apps.intake_note(request, 'routed', 'intake.request.routed',
    pg_catalog.jsonb_build_object('kind', 'lawyer', 'outcome', 'task', 'task_id', task,
      'space_id', space));
  perform apps.intake_note(request, 'assigned', 'intake.request.assigned',
    pg_catalog.jsonb_build_object('assignee_id', chosen));
  perform apps.intake_mail(request, 'assigned', 'assigned:' || task::text);
  perform pg_catalog.set_config('app.workspace_id', was_ws, true);
  return chosen;
end
$$;

-- Records what was made of a request and moves it on. `p_type` null leaves it for a person.
-- Only a type of the request's workspace and only that type's own fields are taken; a matter
-- field is never filled here, and a file field only with a file on the request. Matter and
-- assignee are not parameters, so nothing read from a message can reach them.
create function apps.apply_intake_work(p_request uuid, p_lease uuid, p_type uuid,
                                       p_confidence real, p_fields jsonb, p_candidates jsonb)
returns table (assignee_id uuid, number integer, matter_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  request apps.intake_request;
  kind apps.intake_request_type;
  merged jsonb;
  missing text[];
  ask text;
  asked integer;
  chosen uuid;
  next_status text;
begin
  update apps.intake_work set due_at = null, lease = null, attempts = 0
   where request_id = p_request and lease = p_lease;
  if not found then
    return;
  end if;
  select * into request from apps.intake_request r where r.id = p_request for update;
  if request.task_id is not null
     or request.status not in ('new', 'unclassified', 'awaiting_requester', 'triaged') then
    return;
  end if;
  select * into kind from apps.intake_request_type t
   where t.id = coalesce(request.type_id, p_type) and t.workspace_id = request.workspace_id
     and t.deleted_at is null;
  if kind.id is null then
    update apps.intake_request set classification_confidence = p_confidence
     where id = request.id;
    perform apps.intake_note(request, 'classified', 'intake.request.classified',
      pg_catalog.jsonb_build_object('type_id', null, 'confidence', p_confidence));
    return;
  end if;
  -- What the request already holds stays: a message only fills what is empty.
  select coalesce(pg_catalog.jsonb_object_agg(f.key, f.value), '{}') into merged
    from pg_catalog.jsonb_each(coalesce(p_fields, '{}')) f
   where exists (
     select 1 from pg_catalog.jsonb_array_elements(kind.fields) d
      where d ->> 'key' = f.key and d ->> 'type' <> 'matter'
        and (d ->> 'type' <> 'file' or exists (
              select 1 from apps.intake_attachment a
               where a.request_id = request.id and a.document_id::text = f.value #>> '{}')));
  merged := merged || request.fields;
  select coalesce(pg_catalog.array_agg(d ->> 'key' order by n), '{}') into missing
    from pg_catalog.jsonb_array_elements(kind.fields) with ordinality x(d, n)
   where (d ->> 'required')::boolean and coalesce(pg_catalog.btrim(merged ->> (d ->> 'key')), '') = '';

  -- The first missing one a requester could answer, at most three times.
  if request.channel = 'email' then
    select d ->> 'key' into ask
      from pg_catalog.jsonb_array_elements(kind.fields) with ordinality x(d, n)
     where d ->> 'key' = any (missing) and d ->> 'type' <> 'matter'
     order by n limit 1;
  end if;
  if ask is not null then
    select count(*) into asked from apps.intake_outbound o
     where o.request_id = request.id and o.kind = 'ask' and o.field = ask;
    if asked >= 3 then
      ask := null;
    end if;
  end if;
  next_status := case
    when ask is not null then 'awaiting_requester'
    when request.channel = 'email' or kind.routing is not null then
      case when pg_catalog.cardinality(missing) = 0 then 'triaged'
           when request.status = 'unclassified' then 'new'
           else request.status end
    else request.status end;
  -- A wait the worker began ends once it has no more to ask; one set by hand stays.
  if next_status = 'awaiting_requester' and ask is null and request.channel = 'email'
     and request.asked_field is not null then
    next_status := 'new';
  end if;

  perform pg_catalog.set_config('legallabs.intake_worker', 'on', true);
  update apps.intake_request
     set type_id = kind.id, fields = merged, missing_fields = missing, status = next_status,
         asked_field = ask,
         classification_confidence = coalesce(request.classification_confidence, p_confidence),
         sla_due_at = coalesce(sla_due_at, created_at
                               + pg_catalog.make_interval(hours => kind.sla_hours)),
         updated_at = pg_catalog.now()
   where id = request.id;
  perform pg_catalog.set_config('legallabs.intake_worker', 'off', true);
  if request.type_id is null then
    perform apps.intake_note(request, 'classified', 'intake.request.classified',
      pg_catalog.jsonb_build_object('type_id', kind.id, 'confidence', p_confidence));
  end if;
  if next_status is distinct from request.status then
    perform apps.intake_note(request, 'status', 'intake.request.status_changed',
      pg_catalog.jsonb_build_object('from', request.status, 'to', next_status));
  end if;
  if ask is not null then
    perform apps.intake_mail(request, 'ask', 'ask:' || ask || ':' || (asked + 1), ask);
  elsif pg_catalog.cardinality(missing) = 0 and kind.routing is not null then
    if kind.routing ->> 'kind' = 'lawyer' then
      chosen := apps.route_intake_request(request.id, p_candidates);
    elsif not exists (select 1 from apps.intake_event e
                       where e.request_id = request.id and e.kind = 'routed') then
      -- Intake files are not review material, so these wait for a person.
      perform apps.intake_note(request, 'routed', 'intake.request.routed',
        pg_catalog.jsonb_build_object('kind', kind.routing ->> 'kind', 'outcome', 'manual'));
    end if;
  end if;
  return query select chosen, request.number, request.matter_id;
end
$$;

-- Finishing the task finishes the request.
create function apps.close_intake_for_task() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  was text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  request apps.intake_request;
begin
  select * into request from apps.intake_request r
   where r.task_id = new.id and r.workspace_id = new.workspace_id
     and r.status not in ('done', 'closed') for update;
  if request.id is null then
    return new;
  end if;
  update apps.intake_request set status = 'done', updated_at = pg_catalog.now()
   where id = request.id;
  perform apps.intake_note(request, 'status', 'intake.request.status_changed',
    pg_catalog.jsonb_build_object('from', request.status, 'to', 'done', 'task_id', new.id));
  perform apps.intake_mail(request, 'done', 'done');
  perform pg_catalog.set_config('app.workspace_id', was, true);
  return new;
end
$$;
create trigger intake_task_done after update of status on work.task
  for each row when (new.status = 'done' and old.status <> 'done')
  execute function apps.close_intake_for_task();

-- An answer to our mail joins its request. It must quote a token we sent for that request and
-- come, past the same sender checks, from the address the request came from.
create function apps.append_inbound_reply(p_id uuid, p_lease uuid, p_email text,
                                          p_tokens text[], p_attachments integer) returns uuid
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
    join apps.intake_request r on r.id = o.request_id
   where o.token = any (p_tokens) and o.workspace_id = message.workspace_id
     and r.channel = 'email' and r.requester_email = p_email
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
  return request.id;
end
$$;

-- The next mail to send, from a live channel the request came through. The system's own mail to
-- one address is limited over a day, in all and by how many requests it answers, and what is
-- over is dropped for good: that is what ends two machines answering each other. Every claim
-- counts, sent or not. A lawyer's reply is outside these limits. Nothing is claimed more than
-- five times.
create function apps.claim_intake_mail(p_lease_seconds integer, p_per_day integer,
                                       p_requests_per_day integer,
                                       p_workspaces uuid[] default null)
returns table (id uuid, lease uuid, attempt integer, kind text, body text, token text,
               request_id uuid, number integer, email text, address text, author_name text,
               assignee_name text, prompt text, label text)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  next apps.intake_outbound;
  recipient text;
  spent integer;
  answered integer;
  known boolean;
  claimed uuid;
begin
  loop
    select x.* into next from apps.intake_outbound x
     where x.status = 'queued' and x.next_attempt_at <= pg_catalog.now()
       and (p_workspaces is null or x.workspace_id = any (p_workspaces))
       and exists (select 1 from apps.inbound_email e
                    join apps.intake_channel c on c.id = e.channel_id and c.status = 'live'
                   where e.request_id = x.request_id)
     order by x.next_attempt_at, x.id
     limit 1
     for update of x skip locked;
    exit when next.id is null;
    if next.attempts >= 5 then
      perform apps.drop_intake_mail(next.id, 'attempts');
      continue;
    end if;
    if next.kind <> 'reply' then
      select r.requester_email into recipient from apps.intake_request r
       where r.id = next.request_id;
      -- So two servers cannot each count before the other's claim is seen.
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'apps.intake_mail ' || next.workspace_id::text || ' ' || recipient, 0));
      select coalesce(sum(s.attempts), 0),
             count(distinct s.request_id) filter (where s.request_id <> next.request_id),
             coalesce(bool_or(s.request_id = next.request_id), false)
        into spent, answered, known
        from apps.intake_outbound s
        join apps.intake_request q on q.id = s.request_id
       where s.workspace_id = next.workspace_id and s.kind <> 'reply'
         and s.claimed_at > pg_catalog.now() - interval '24 hours'
         and q.requester_email = recipient;
      if spent >= p_per_day or (not known and answered >= p_requests_per_day) then
        perform apps.drop_intake_mail(next.id, 'limit');
        continue;
      end if;
    end if;
    update apps.intake_outbound o
       set attempts = o.attempts + 1, lease = pg_catalog.gen_random_uuid(),
           claimed_at = pg_catalog.now(),
           next_attempt_at = pg_catalog.now()
                             + pg_catalog.make_interval(secs => p_lease_seconds)
     where o.id = next.id;
    claimed := next.id;
    exit;
  end loop;
  return query
    select o.id, o.lease, o.attempts, o.kind, o.body, o.token, r.id, r.number,
           r.requester_email,
           (select c.address from apps.inbound_email e
              join apps.intake_channel c on c.id = e.channel_id and c.status = 'live'
             where e.request_id = r.id order by e.received_at, e.id limit 1),
           (select nullif(u.name, '') from core."user" u where u.id = o.created_by),
           (select nullif(u.name, '') from core."user" u where u.id = r.assignee_id),
           f.d ->> 'prompt', f.d ->> 'label'
      from apps.intake_outbound o
      join apps.intake_request r on r.id = o.request_id
      left join apps.intake_request_type t on t.id = r.type_id
      left join lateral (select d from pg_catalog.jsonb_array_elements(t.fields) d
                          where d ->> 'key' = o.field limit 1) f on true
     where o.id = claimed;
end
$$;

-- Gives up on mail without sending it, and says so on the request.
create function apps.drop_intake_mail(p_id uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  mail apps.intake_outbound;
  request apps.intake_request;
begin
  update apps.intake_outbound set status = 'failed', lease = null, body = null
   where id = p_id and status = 'queued'
  returning * into mail;
  if mail.id is null then
    return;
  end if;
  select * into request from apps.intake_request r where r.id = mail.request_id;
  perform apps.intake_note(request, 'outbound', 'intake.request.delivery_failed',
    pg_catalog.jsonb_build_object('mail', mail.kind, 'outcome', 'failed',
      'outbound_id', mail.id, 'reason', p_reason));
end
$$;

-- Ends an attempt: sent, to try again after `p_retry_seconds`, or given up.
create function apps.end_intake_mail(p_id uuid, p_lease uuid, p_status text,
                                     p_retry_seconds integer default 0) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  was text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  mail apps.intake_outbound;
  request apps.intake_request;
begin
  if p_status = 'queued' then
    update apps.intake_outbound
       set lease = null,
           next_attempt_at = pg_catalog.now()
                             + pg_catalog.make_interval(secs => p_retry_seconds)
     where id = p_id and lease = p_lease and status = 'queued';
    return;
  end if;
  update apps.intake_outbound
     set status = p_status, lease = null, body = null,
         sent_at = case when p_status = 'sent' then pg_catalog.now() end
   where id = p_id and lease = p_lease and status = 'queued'
  returning * into mail;
  if mail.id is null then
    return;
  end if;
  select * into request from apps.intake_request r where r.id = mail.request_id;
  perform apps.intake_note(request, 'outbound',
    case when p_status = 'failed' then 'intake.request.delivery_failed' end,
    pg_catalog.jsonb_build_object('mail', mail.kind, 'outcome', p_status,
      'outbound_id', mail.id));
  perform pg_catalog.set_config('app.workspace_id', was, true);
end
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'apps.queue_intake_work(uuid, uuid)', 'apps.intake_request_changed()',
    'apps.intake_note(apps.intake_request, text, text, jsonb)',
    'apps.intake_mail(apps.intake_request, text, text, text)',
    'apps.claim_intake_work(integer, uuid[])', 'apps.spend_intake_call(uuid, uuid)',
    'apps.postpone_intake_work(uuid, uuid, integer)',
    'apps.intake_eligible(uuid, uuid, uuid)', 'apps.route_intake_request(uuid, jsonb)',
    'apps.apply_intake_work(uuid, uuid, uuid, real, jsonb, jsonb)',
    'apps.close_intake_for_task()',
    'apps.append_inbound_reply(uuid, uuid, text, text[], integer)',
    'apps.claim_intake_mail(integer, integer, integer, uuid[])',
    'apps.drop_intake_mail(uuid, text)',
    'apps.end_intake_mail(uuid, uuid, text, integer)']
  loop
    execute pg_catalog.format('alter function %s owner to legallabs_definer', fn);
    execute pg_catalog.format('revoke execute on function %s from public', fn);
  end loop;
end
$$;
grant execute on function apps.claim_intake_work(integer, uuid[]),
  apps.spend_intake_call(uuid, uuid), apps.postpone_intake_work(uuid, uuid, integer),
  apps.apply_intake_work(uuid, uuid, uuid, real, jsonb, jsonb),
  apps.append_inbound_reply(uuid, uuid, text, text[], integer),
  apps.claim_intake_mail(integer, integer, integer, uuid[]),
  apps.end_intake_mail(uuid, uuid, text, integer) to legallabs_worker;
