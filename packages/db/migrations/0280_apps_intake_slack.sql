-- Intake from Slack. A channel holds the Slack app's signing secret and, when the workspace
-- wants answers sent, its bot token, both sealed. What Slack posts waits in the same queue as
-- mail, under the same caps and turns, and becomes a request by functions only the worker may
-- call. Nobody in Slack becomes a user, and no name or id from Slack chooses anyone here.

alter table apps.intake_channel drop constraint intake_channel_kind_check;
alter table apps.intake_channel add constraint intake_channel_kind_check
  check (kind in ('email', 'slack'));
alter table apps.intake_channel alter column address drop not null;
alter table apps.intake_channel alter column authserv_id drop not null;
alter table apps.intake_channel alter column allowed_domains drop not null;
alter table apps.intake_channel add column team_id text
  check (team_id ~ '^T[A-Z0-9]{2,30}$');
-- The Slack channels a new request may be made from.
alter table apps.intake_channel add column slack_channel_ids text[]
  check (cardinality(slack_channel_ids) between 1 and 50);
alter table apps.intake_channel add column bot_token_sealed bytea;
alter table apps.intake_channel add constraint intake_channel_shape check (
  case kind
    when 'email' then num_nulls(address, authserv_id, allowed_domains) = 0
                      and num_nonnulls(team_id, slack_channel_ids, bot_token_sealed) = 0
    else num_nulls(team_id, slack_channel_ids) = 0
         and num_nonnulls(address, authserv_id, allowed_domains) = 0
  end);
grant update (team_id, slack_channel_ids, bot_token_sealed) on apps.intake_channel
  to legallabs_app;

-- Where a request lives in Slack. A slash command has no message to answer under, so its
-- thread is the one the first message to the requester starts.
create table apps.slack_thread (
  request_id uuid primary key,
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  channel_id uuid not null,
  slack_user text not null check (slack_user ~ '^[UW][A-Z0-9]{2,30}$'),
  slack_channel text check (slack_channel ~ '^[CDG][A-Z0-9]{2,30}$'),
  thread_ts text check (thread_ts ~ '^[0-9]{1,16}\.[0-9]{1,9}$'),
  created_at timestamptz not null default now(),
  check ((slack_channel is null) = (thread_ts is null)),
  foreign key (workspace_id, request_id) references apps.intake_request (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, channel_id) references apps.intake_channel (workspace_id, id)
    on delete cascade
);
create index slack_thread_message_idx
  on apps.slack_thread (channel_id, slack_channel, thread_ts);
alter table apps.slack_thread enable row level security;
alter table apps.slack_thread force row level security;
grant select, insert, update on apps.slack_thread to legallabs_definer;
create policy definer_all on apps.slack_thread for all to legallabs_definer
  using (true) with check (true);
create policy definer_insert_slack on apps.intake_request for insert to legallabs_definer
  with check (channel = 'slack');

alter table apps.intake_outbound drop constraint intake_outbound_kind_check;
alter table apps.intake_outbound add constraint intake_outbound_kind_check check (kind in
  ('ack', 'ask', 'assigned', 'done', 'reply', 'reminder', 'no_response', 'merged'));
-- The id the other end gave a message that was sent.
alter table apps.intake_outbound add column external_ref text
  check (char_length(external_ref) <= 100);

drop policy intake_outbound_reply on apps.intake_outbound;
create policy intake_outbound_reply on apps.intake_outbound for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and kind = 'reply' and status = 'queued'
              and field is null and external_ref is null
              and created_by = core.current_user_id()
              and exists (select 1 from apps.intake_request r
                           where r.id = request_id and r.channel in ('email', 'slack')
                             and r.status not in ('done', 'closed')));

-- As 0233, but each kind of channel is opened only for its own hook: both are signed the same
-- way, so a request for one must never be taken by the other.
create or replace function apps.open_email_channel(p_key text)
returns table (id uuid, workspace_id uuid, address text, authserv_id text,
               allowed_domains text[], secret_sealed bytea, previous_secret_sealed bytea,
               previous_secret_until timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, c.address, c.authserv_id, c.allowed_domains, c.secret_sealed,
         c.previous_secret_sealed, c.previous_secret_until
    from apps.intake_channel c
   where c.key = p_key and c.kind = 'email' and c.status = 'live'
$$;

-- As 0233, audited under the kind of channel it came to.
create or replace function apps.end_inbound_email(p_id uuid, p_status text, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  was text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  ws uuid;
  channel uuid;
  origin text;
begin
  update apps.inbound_email
     set status = p_status, reason = p_reason, raw = null, lease = null,
         processed_at = pg_catalog.now()
   where id = p_id and status = 'queued'
  returning workspace_id, channel_id into ws, channel;
  if ws is null then
    return;
  end if;
  select c.kind into origin from apps.intake_channel c where c.id = channel;
  perform pg_catalog.set_config('app.workspace_id', ws::text, true);
  perform admin.append_audit_event(origin || '.inbound_' || p_status, 'system', null,
    'intake_channel', channel::text, pg_catalog.jsonb_build_object('reason', p_reason));
  perform pg_catalog.set_config('app.workspace_id', was, true);
end
$$;

-- As 0233, for mail only.
create or replace function apps.claim_inbound_email(p_lease_seconds integer, p_per_hour integer,
                                         p_max_attempts integer,
                                         p_workspaces uuid[] default null)
returns table (id uuid, workspace_id uuid, channel_id uuid, service_user_id uuid,
               vault_id uuid, raw bytea, address text, authserv_id text, allowed_domains text[], attempt integer,
               lease uuid)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  spent uuid;
  claimed uuid;
begin
  -- Cut off every time it was tried: most likely it is what cuts the worker off.
  for spent in
    select e.id from apps.inbound_email e
     where e.status = 'queued' and e.attempts >= p_max_attempts
       and e.next_attempt_at <= pg_catalog.now()
       and (p_workspaces is null or e.workspace_id = any (p_workspaces))
     for update skip locked
  loop
    perform apps.end_inbound_email(spent, 'failed', 'processing_failed');
  end loop;
  update apps.inbound_email e
     set attempts = e.attempts + 1, lease = pg_catalog.gen_random_uuid(),
         claimed_at = pg_catalog.clock_timestamp(),
         next_attempt_at = pg_catalog.now()
                           + pg_catalog.make_interval(secs => p_lease_seconds)
   where e.id = (
     select x.id from apps.inbound_email x
       join apps.intake_channel c on c.id = x.channel_id and c.status = 'live'
        and c.kind = 'email'
      where x.status = 'queued' and x.next_attempt_at <= pg_catalog.now()
        and (p_workspaces is null or x.workspace_id = any (p_workspaces))
        and (select count(*) from apps.inbound_email d
              where d.workspace_id = x.workspace_id and d.status = 'accepted'
                and d.processed_at > pg_catalog.now() - interval '1 hour') < p_per_hour
      order by (select max(d.claimed_at) from apps.inbound_email d
                 where d.workspace_id = x.workspace_id) nulls first,
               x.received_at, x.id
      limit 1
      for update of x skip locked)
  returning e.id into claimed;
  return query
    select e.id, e.workspace_id, e.channel_id, i.service_user_id, i.vault_id, e.raw, c.address,
           c.authserv_id, c.allowed_domains, e.attempts, e.lease
      from apps.inbound_email e
      join apps.intake_channel c on c.id = e.channel_id
      join apps.intake_inbox i on i.workspace_id = e.workspace_id
     where e.id = claimed;
end
$$;

-- As 0234, for Slack requests too.
create or replace function apps.intake_request_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (tg_op = 'INSERT' and (new.channel in ('email', 'slack') or new.type_id is not null))
     or (tg_op = 'UPDATE' and new.type_id is distinct from old.type_id
         and pg_catalog.current_setting('legallabs.intake_worker', true) is distinct from 'on')
  then
    perform apps.queue_intake_work(new.workspace_id, new.id);
  end if;
  return new;
end
$$;

-- As 0234, for Slack requesters too.
create or replace function apps.intake_mail(p_request apps.intake_request, p_kind text,
                                            p_ref text, p_field text default null) returns void
language sql volatile security definer set search_path = '' as $$
  insert into apps.intake_outbound (workspace_id, request_id, kind, ref, field)
  select p_request.workspace_id, p_request.id, p_kind, p_ref, p_field
   where (p_request.channel = 'email' and p_request.requester_email is not null)
      or p_request.channel = 'slack'
  on conflict (request_id, ref) do nothing
$$;

-- As 0234: a Slack requester is asked and moved on as a mail one is.
create or replace function apps.apply_intake_work(p_request uuid, p_lease uuid, p_type uuid,
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
  if request.channel in ('email', 'slack') then
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
    when request.channel in ('email', 'slack') or kind.routing is not null then
      case when pg_catalog.cardinality(missing) = 0 then 'triaged'
           when request.status = 'unclassified' then 'new'
           else request.status end
    else request.status end;
  -- A wait the worker began ends once it has no more to ask; one set by hand stays.
  if next_status = 'awaiting_requester' and ask is null and request.channel in ('email', 'slack')
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

-- As 0235, for Slack requesters too.
create or replace function apps.intake_wait_start(p_request apps.intake_request) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select max(o.sent_at) from apps.intake_outbound o
   where p_request.status = 'awaiting_requester' and p_request.channel in ('email', 'slack')
     and p_request.asked_field is not null
     and o.request_id = p_request.id and o.kind in ('ask', 'reply') and o.status = 'sent'
     -- An answer, even one that did not help, starts the wait again.
     and o.created_at >= greatest(p_request.awaiting_since,
           (select max(e.processed_at) from apps.inbound_email e
             where e.request_id = p_request.id))
$$;

-- As 0234, for requests that came by mail only.
create or replace function apps.claim_intake_mail(p_lease_seconds integer, p_per_day integer,
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
       and exists (select 1 from apps.intake_request q
                    where q.id = x.request_id and q.channel = 'email')
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

-- What follows is for the Slack hook and its workers, which have no identity.

create function apps.open_slack_channel(p_key text)
returns table (id uuid, workspace_id uuid, team_id text, slack_channel_ids text[],
               secret_sealed bytea)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, c.team_id, c.slack_channel_ids, c.secret_sealed
    from apps.intake_channel c
   where c.key = p_key and c.kind = 'slack' and c.status = 'live'
$$;

-- Queues what a signed post said, under the caps and repeat checks of any queued message. An
-- answer in a thread is kept only when it is under an open request of this channel, from the
-- person who made it: nothing else said in a thread is stored at all.
create function apps.receive_slack_event(p_channel uuid, p_raw bytea, p_from_hash bytea,
                                         p_slack_channel text, p_thread_ts text,
                                         p_user text) returns text
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not exists (select 1 from apps.intake_channel c
                  where c.id = p_channel and c.kind = 'slack' and c.status = 'live') then
    return 'unknown';
  end if;
  if p_thread_ts is not null and apps.slack_thread_request(p_channel, p_slack_channel,
                                                           p_thread_ts, p_user) is null then
    return 'ignored';
  end if;
  return apps.receive_inbound_email(p_channel, p_raw, p_from_hash, null);
end
$$;

-- The open request a thread answers: this person's, or the one it was merged into when that
-- is theirs too.
create function apps.slack_thread_request(p_channel uuid, p_slack_channel text,
                                          p_thread_ts text, p_user text) returns uuid
language sql stable security definer set search_path = '' as $$
  select r.id
    from apps.slack_thread t
    join apps.intake_request q on q.id = t.request_id
    join apps.intake_request r on r.id = coalesce(q.merged_into, q.id)
     and r.channel = 'slack' and r.requester_id = q.requester_id
   where t.channel_id = p_channel and t.slack_channel = p_slack_channel
     and t.thread_ts = p_thread_ts and t.slack_user = p_user
     and r.status not in ('done', 'closed')
   order by r.created_at desc, r.id desc
   limit 1
$$;

-- As claim_inbound_email, for Slack: workspaces in turn, and the same hourly limit.
create function apps.claim_slack_event(p_lease_seconds integer, p_per_hour integer,
                                       p_max_attempts integer,
                                       p_workspaces uuid[] default null)
returns table (id uuid, workspace_id uuid, channel_id uuid, service_user_id uuid,
               vault_id uuid, raw bytea, bot_token_sealed bytea, attempt integer, lease uuid)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  spent uuid;
  claimed uuid;
begin
  for spent in
    select e.id from apps.inbound_email e
      join apps.intake_channel c on c.id = e.channel_id and c.kind = 'slack'
     where e.status = 'queued' and e.attempts >= p_max_attempts
       and e.next_attempt_at <= pg_catalog.now()
       and (p_workspaces is null or e.workspace_id = any (p_workspaces))
     for update of e skip locked
  loop
    perform apps.end_inbound_email(spent, 'failed', 'processing_failed');
  end loop;
  update apps.inbound_email e
     set attempts = e.attempts + 1, lease = pg_catalog.gen_random_uuid(),
         claimed_at = pg_catalog.clock_timestamp(),
         next_attempt_at = pg_catalog.now()
                           + pg_catalog.make_interval(secs => p_lease_seconds)
   where e.id = (
     select x.id from apps.inbound_email x
       join apps.intake_channel c on c.id = x.channel_id and c.status = 'live'
        and c.kind = 'slack'
      where x.status = 'queued' and x.next_attempt_at <= pg_catalog.now()
        and (p_workspaces is null or x.workspace_id = any (p_workspaces))
        and (select count(*) from apps.inbound_email d
              where d.workspace_id = x.workspace_id and d.status = 'accepted'
                and d.processed_at > pg_catalog.now() - interval '1 hour') < p_per_hour
      order by (select max(d.claimed_at) from apps.inbound_email d
                 where d.workspace_id = x.workspace_id) nulls first,
               x.received_at, x.id
      limit 1
      for update of x skip locked)
  returning e.id into claimed;
  return query
    select e.id, e.workspace_id, e.channel_id, i.service_user_id, i.vault_id, e.raw,
           c.bot_token_sealed, e.attempts, e.lease
      from apps.inbound_email e
      join apps.intake_channel c on c.id = e.channel_id
      join apps.intake_inbox i on i.workspace_id = e.workspace_id
     where e.id = claimed;
end
$$;

-- Makes the request, its thread and the first answer to the requester, all at once. The
-- Slack user is a requester and nothing else: no matter, assignee, type or user comes from
-- them. The team is the channel's own, not one the message names.
create function apps.file_slack_event(p_id uuid, p_lease uuid, p_user text, p_name text,
                                      p_slack_channel text, p_thread_ts text,
                                      p_attachments integer) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  was text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  message apps.inbound_email;
  source apps.intake_channel;
  requester uuid;
  request apps.intake_request;
  external text;
begin
  select * into message from apps.inbound_email e
   where e.id = p_id and e.lease = p_lease and e.status = 'queued'
     and e.message_hash is not null for update;
  select * into source from apps.intake_channel c
   where c.id = message.channel_id and c.kind = 'slack';
  if source.id is null then
    return null;
  end if;
  external := source.team_id || ':' || p_user;
  insert into apps.intake_requester (workspace_id, channel, external_user_id, display_name)
  values (message.workspace_id, 'slack', external, p_name)
  on conflict (workspace_id, channel, external_user_id) do nothing;
  select r.id into requester from apps.intake_requester r
   where r.workspace_id = message.workspace_id and r.channel = 'slack'
     and r.external_user_id = external;
  insert into apps.intake_request (workspace_id, channel, external_ref, requester_id,
    requester_name, status)
  values (message.workspace_id, 'slack',
          'slack:' || pg_catalog.encode(message.message_hash, 'hex'), requester, p_name,
          'unclassified')
  returning * into request;
  insert into apps.slack_thread (request_id, workspace_id, channel_id, slack_user,
    slack_channel, thread_ts)
  values (request.id, message.workspace_id, source.id, p_user, p_slack_channel, p_thread_ts);
  update apps.intake_attachment set request_id = request.id
   where inbound_email_id = p_id and request_id is null;
  insert into apps.intake_event (workspace_id, request_id, kind, actor_type, details)
  values (message.workspace_id, request.id, 'inbound', 'requester',
          pg_catalog.jsonb_build_object('channel', 'slack', 'attachments', p_attachments));
  update apps.inbound_email
     set status = 'accepted', raw = null, lease = null, processed_at = pg_catalog.now(),
         request_id = request.id, attachment_count = p_attachments
   where id = p_id;
  perform apps.intake_mail(request, 'ack', 'ack');
  perform pg_catalog.set_config('app.workspace_id', message.workspace_id::text, true);
  perform admin.append_audit_event('intake.request.created', 'system', null, 'intake_request',
    request.id::text, pg_catalog.jsonb_build_object('channel', 'slack',
      'attachments', p_attachments, 'channel_id', message.channel_id));
  perform pg_catalog.set_config('app.workspace_id', was, true);
  return request.id;
end
$$;

-- An answer in the request's thread joins it. Null when there is no longer one to join.
create function apps.append_slack_reply(p_id uuid, p_lease uuid, p_user text,
                                        p_slack_channel text, p_thread_ts text,
                                        p_attachments integer) returns uuid
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
  select * into request from apps.intake_request r
   where r.id = apps.slack_thread_request(message.channel_id, p_slack_channel, p_thread_ts,
                                          p_user)
     and r.workspace_id = message.workspace_id and r.status not in ('done', 'closed')
   for update;
  if request.id is null then
    return null;
  end if;
  update apps.intake_attachment set request_id = request.id
   where inbound_email_id = p_id and request_id is null;
  insert into apps.intake_event (workspace_id, request_id, kind, actor_type, details)
  values (message.workspace_id, request.id, 'inbound', 'requester',
          pg_catalog.jsonb_build_object('channel', 'slack', 'attachments', p_attachments));
  update apps.inbound_email
     set status = 'accepted', raw = null, lease = null, processed_at = pg_catalog.now(),
         request_id = request.id, attachment_count = p_attachments
   where id = p_id;
  perform apps.queue_intake_work(request.workspace_id, request.id);
  update apps.intake_sweep set due_at = pg_catalog.now() where request_id = request.id;
  return request.id;
end
$$;

-- The next message to post, from a live channel that has a bot token: workspaces in turn, and
-- each request's messages in order. The system's own messages to one person are limited over
-- a day, in all and by how many requests it answers, and what is over is dropped for good.
create function apps.claim_slack_post(p_lease_seconds integer, p_per_day integer,
                                      p_requests_per_day integer,
                                      p_workspaces uuid[] default null)
returns table (id uuid, lease uuid, attempt integer, kind text, body text, request_id uuid,
               number integer, author_name text, assignee_name text, prompt text,
               label text, slack_user text, slack_channel text, thread_ts text,
               bot_token_sealed bytea)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  next apps.intake_outbound;
  recipient uuid;
  spent integer;
  answered integer;
  known boolean;
  claimed uuid;
begin
  loop
    select x.* into next from apps.intake_outbound x
      join apps.slack_thread t on t.request_id = x.request_id
      join apps.intake_channel c on c.id = t.channel_id and c.status = 'live'
       and c.bot_token_sealed is not null
     where x.status = 'queued' and x.next_attempt_at <= pg_catalog.now()
       and (p_workspaces is null or x.workspace_id = any (p_workspaces))
       and not exists (select 1 from apps.intake_outbound o
                        where o.request_id = x.request_id and o.status = 'queued'
                          and (o.created_at, o.id) < (x.created_at, x.id))
     order by (select max(o.claimed_at) from apps.intake_outbound o
                where o.workspace_id = x.workspace_id) nulls first,
              x.next_attempt_at, x.id
     limit 1
     for update of x skip locked;
    exit when next.id is null;
    if next.attempts >= 5 then
      perform apps.drop_intake_mail(next.id, 'attempts');
      continue;
    end if;
    if next.kind <> 'reply' then
      select r.requester_id into recipient from apps.intake_request r
       where r.id = next.request_id;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'apps.intake_slack ' || recipient::text, 0));
      select coalesce(sum(s.attempts), 0),
             count(distinct s.request_id) filter (where s.request_id <> next.request_id),
             coalesce(bool_or(s.request_id = next.request_id), false)
        into spent, answered, known
        from apps.intake_outbound s
        join apps.intake_request q on q.id = s.request_id
       where s.workspace_id = next.workspace_id and s.kind <> 'reply'
         and s.claimed_at > pg_catalog.now() - interval '24 hours'
         and q.requester_id = recipient;
      if spent >= p_per_day or (not known and answered >= p_requests_per_day) then
        perform apps.drop_intake_mail(next.id, 'limit');
        continue;
      end if;
    end if;
    update apps.intake_outbound o
       set attempts = o.attempts + 1, lease = pg_catalog.gen_random_uuid(),
           claimed_at = pg_catalog.clock_timestamp(),
           next_attempt_at = pg_catalog.now()
                             + pg_catalog.make_interval(secs => p_lease_seconds)
     where o.id = next.id;
    claimed := next.id;
    exit;
  end loop;
  return query
    select o.id, o.lease, o.attempts, o.kind, o.body, r.id, r.number,
           (select nullif(u.name, '') from core."user" u where u.id = o.created_by),
           (select nullif(u.name, '') from core."user" u where u.id = r.assignee_id),
           f.d ->> 'prompt', f.d ->> 'label', t.slack_user, t.slack_channel, t.thread_ts,
           c.bot_token_sealed
      from apps.intake_outbound o
      join apps.intake_request r on r.id = o.request_id
      join apps.slack_thread t on t.request_id = r.id
      join apps.intake_channel c on c.id = t.channel_id
      left join apps.intake_request_type k on k.id = r.type_id
      left join lateral (select d from pg_catalog.jsonb_array_elements(k.fields) d
                          where d ->> 'key' = o.field limit 1) f on true
     where o.id = claimed;
end
$$;

-- A message Slack took: its id is kept, and starts the thread when there was none.
create function apps.sent_slack_post(p_id uuid, p_lease uuid, p_slack_channel text,
                                     p_ts text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  request uuid;
begin
  update apps.intake_outbound set external_ref = p_slack_channel || ':' || p_ts
   where id = p_id and lease = p_lease and status = 'queued'
  returning request_id into request;
  if request is null then
    return;
  end if;
  update apps.slack_thread set slack_channel = p_slack_channel, thread_ts = p_ts
   where request_id = request and thread_ts is null;
  perform apps.end_intake_mail(p_id, p_lease, 'sent', 0);
end
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'apps.open_slack_channel(text)',
    'apps.receive_slack_event(uuid, bytea, bytea, text, text, text)',
    'apps.slack_thread_request(uuid, text, text, text)',
    'apps.claim_slack_event(integer, integer, integer, uuid[])',
    'apps.file_slack_event(uuid, uuid, text, text, text, text, integer)',
    'apps.append_slack_reply(uuid, uuid, text, text, text, integer)',
    'apps.claim_slack_post(integer, integer, integer, uuid[])',
    'apps.sent_slack_post(uuid, uuid, text, text)']
  loop
    execute pg_catalog.format('alter function %s owner to legallabs_definer', fn);
    execute pg_catalog.format('revoke execute on function %s from public', fn);
  end loop;
end
$$;
grant execute on function apps.open_slack_channel(text),
  apps.receive_slack_event(uuid, bytea, bytea, text, text, text),
  apps.claim_slack_event(integer, integer, integer, uuid[]),
  apps.file_slack_event(uuid, uuid, text, text, text, text, integer),
  apps.append_slack_reply(uuid, uuid, text, text, text, integer),
  apps.claim_slack_post(integer, integer, integer, uuid[]),
  apps.sent_slack_post(uuid, uuid, text, text) to legallabs_worker;
