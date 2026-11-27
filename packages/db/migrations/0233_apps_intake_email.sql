-- Intake by email. The receiving mail server posts each message to a channel's own address on
-- this server, signed with the channel's secret; it waits in a queue and is then read. Nobody
-- who sends one has an account, and nothing here makes them a user.

create table apps.intake_channel (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  kind text not null default 'email' check (kind = 'email'),
  -- Names the channel in the hook's path. Not a secret: the signature is what is checked.
  key text not null unique check (key ~ '^[A-Za-z0-9_-]{32}$'),
  name text not null check (char_length(name) between 1 and 100),
  address text not null check (char_length(address) between 3 and 320),
  authserv_id text not null check (char_length(authserv_id) between 1 and 255),
  allowed_domains text[] not null check (cardinality(allowed_domains) between 1 and 50),
  -- Sealed with the deployment's secrets key. The previous one works until its time is up.
  secret_sealed bytea not null,
  previous_secret_sealed bytea,
  previous_secret_until timestamptz,
  status text not null default 'live' check (status in ('live', 'disabled')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, name),
  foreign key (workspace_id, created_by) references core."user" (workspace_id, id)
);

-- The queue, and afterwards the log of what came. The message is held only while it waits:
-- no address, subject or body stays behind, only hashes, sizes and the outcome.
create table apps.inbound_email (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  channel_id uuid not null,
  received_at timestamptz not null default now(),
  -- Of the whole signed body, so a repeat is taken once.
  event_hash bytea not null,
  size_bytes integer not null check (size_bytes >= 0),
  status text not null default 'queued'
    check (status in ('queued', 'accepted', 'rejected', 'failed')),
  reason text check (char_length(reason) <= 50),
  raw bytea,
  from_hash bytea,
  -- Of the channel, sender and Message-ID together, so nobody can use up another's.
  message_hash bytea,
  attachment_count integer,
  request_id uuid,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease uuid,
  claimed_at timestamptz,
  processed_at timestamptz,
  check ((status = 'queued') = (raw is not null)),
  unique (workspace_id, id),
  unique (channel_id, event_hash),
  foreign key (workspace_id, channel_id) references apps.intake_channel (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, request_id) references apps.intake_request (workspace_id, id)
    on delete set null (request_id)
);
create unique index inbound_email_message_idx on apps.inbound_email (channel_id, message_hash)
  where message_hash is not null and status in ('queued', 'accepted');
create index inbound_email_due_idx on apps.inbound_email (next_attempt_at)
  where status = 'queued';
create index inbound_email_processed_idx on apps.inbound_email (workspace_id, processed_at);
create index inbound_email_claimed_idx on apps.inbound_email (workspace_id, claimed_at);
create index inbound_email_sender_idx on apps.inbound_email (channel_id, from_hash)
  where status = 'queued';
create index inbound_email_rejected_idx on apps.inbound_email (channel_id, processed_at)
  where status = 'rejected';

-- A file that came by email has no person who added it. Until its request exists it is hidden
-- from everyone, as 0232 hides any file that is not the caller's own.
alter table apps.intake_attachment alter column added_by drop not null;
alter table apps.intake_attachment add column inbound_email_id uuid;
alter table apps.intake_attachment add column part_no integer;
alter table apps.intake_attachment add foreign key (workspace_id, inbound_email_id)
  references apps.inbound_email (workspace_id, id);
alter table apps.intake_attachment add unique (inbound_email_id, part_no);
alter table apps.intake_attachment add check (
  num_nonnulls(added_by, inbound_email_id) = 1
  and num_nonnulls(inbound_email_id, part_no) <> 1);

alter table apps.intake_channel enable row level security;
alter table apps.intake_channel force row level security;
alter table apps.inbound_email enable row level security;
alter table apps.inbound_email force row level security;

grant select, insert on apps.intake_channel to legallabs_app;
grant update (name, address, authserv_id, allowed_domains, status, secret_sealed,
              previous_secret_sealed, previous_secret_until, updated_at)
  on apps.intake_channel to legallabs_app;
create policy intake_channel_read on apps.intake_channel for select to legallabs_app
  using (core.in_tenant(workspace_id) and apps.intake_may('intake.manage'));
create policy intake_channel_insert on apps.intake_channel for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and apps.intake_may('intake.manage')
              and created_by = core.current_user_id() and status = 'live');
create policy intake_channel_update on apps.intake_channel for update to legallabs_app
  using (core.in_tenant(workspace_id) and apps.intake_may('intake.manage'))
  with check (core.in_tenant(workspace_id) and apps.intake_may('intake.manage'));

-- The app role has no grant on the queue at all: only the functions below touch it.
grant select on apps.intake_channel to legallabs_definer;
grant select, insert, update on apps.inbound_email to legallabs_definer;
grant insert on apps.intake_request, apps.intake_event to legallabs_definer;
grant update on apps.intake_attachment to legallabs_definer;
create policy definer_read on apps.intake_channel for select to legallabs_definer using (true);
create policy definer_all on apps.inbound_email for all to legallabs_definer
  using (true) with check (true);
create policy definer_insert on apps.intake_request for insert to legallabs_definer
  with check (channel = 'email');
create policy definer_insert on apps.intake_event for insert to legallabs_definer
  with check (actor_type = 'requester');
create policy definer_update on apps.intake_attachment for update to legallabs_definer
  using (true) with check (true);

-- Whether a message is still waiting, for the policy below.
create function apps.inbound_email_pending(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from apps.inbound_email e
                  where e.id = p_id and e.status = 'queued'
                    and e.workspace_id = core.current_workspace_id())
$$;
alter function apps.inbound_email_pending(uuid) owner to legallabs_definer;
revoke execute on function apps.inbound_email_pending(uuid) from public;
grant execute on function apps.inbound_email_pending(uuid) to legallabs_app;

create policy intake_attachment_email_insert on apps.intake_attachment
  for insert to legallabs_app
  with check (core.in_tenant(workspace_id)
              and apps.is_intake_principal(core.current_user_id()) and request_id is null
              and added_by is null and apps.inbound_email_pending(inbound_email_id)
              and exists (select 1 from content.document d
                           where d.id = document_id and d.parent_id is null
                             and d.matter_id is null and apps.is_intake_vault(d.vault_id)));

create function apps.drop_disabled_channel_mail() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update apps.inbound_email
     set status = 'rejected', reason = 'channel_disabled', raw = null,
         processed_at = pg_catalog.now()
   where channel_id = new.id and status = 'queued';
  return new;
end
$$;
alter function apps.drop_disabled_channel_mail() owner to legallabs_definer;
revoke execute on function apps.drop_disabled_channel_mail() from public;
create trigger intake_channel_disabled after update of status on apps.intake_channel
  for each row when (new.status = 'disabled') execute function apps.drop_disabled_channel_mail();

-- What follows is for the hook and the queue's worker, which have no identity. Each does one
-- thing, and learns the workspace from the row rather than from anything a caller sends.

create function apps.open_email_channel(p_key text)
returns table (id uuid, workspace_id uuid, address text, authserv_id text,
               allowed_domains text[], secret_sealed bytea, previous_secret_sealed bytea,
               previous_secret_until timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.id, c.workspace_id, c.address, c.authserv_id, c.allowed_domains, c.secret_sealed,
         c.previous_secret_sealed, c.previous_secret_until
    from apps.intake_channel c
   where c.key = p_key and c.status = 'live'
$$;

-- Takes a signed message. One the headers already rule out (`p_reason`) is only recorded, so
-- it holds no place in the queue; what is refused is limited apart from what is taken. The caps
-- on what waits, in all and from one sender, make the rest the mail server's to retry.
create function apps.receive_inbound_email(p_channel uuid, p_raw bytea, p_from_hash bytea,
                                           p_reason text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  ws uuid;
  hash bytea := pg_catalog.sha256(p_raw);
  size integer := pg_catalog.octet_length(p_raw);
  message uuid;
  waiting integer;
  bytes bigint;
  theirs integer;
  their_bytes bigint;
begin
  select c.workspace_id into ws from apps.intake_channel c
   where c.id = p_channel and c.status = 'live';
  if ws is null then
    return 'unknown';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('apps.inbound_email ' || p_channel::text, 0));
  if exists (select 1 from apps.inbound_email e
              where e.channel_id = p_channel and e.event_hash = hash) then
    return 'duplicate';
  end if;
  if p_reason is not null then
    if (select count(*) from apps.inbound_email e
         where e.channel_id = p_channel and e.status = 'rejected'
           and e.processed_at > pg_catalog.now() - interval '1 hour') >= 600 then
      return 'full';
    end if;
    insert into apps.inbound_email (workspace_id, channel_id, event_hash, size_bytes, raw)
    values (ws, p_channel, hash, size, ''::bytea)
    returning id into message;
    perform apps.end_inbound_email(message, 'rejected', p_reason);
    return 'rejected';
  end if;
  select count(*), coalesce(sum(e.size_bytes), 0),
         count(*) filter (where e.from_hash = p_from_hash),
         coalesce(sum(e.size_bytes) filter (where e.from_hash = p_from_hash), 0)
    into waiting, bytes, theirs, their_bytes
    from apps.inbound_email e where e.channel_id = p_channel and e.status = 'queued';
  if waiting >= 500 or bytes + size > 209715200
     or theirs >= 50 or their_bytes + size > 52428800 then
    return 'full';
  end if;
  insert into apps.inbound_email
    (workspace_id, channel_id, event_hash, size_bytes, raw, from_hash)
  values (ws, p_channel, hash, size, p_raw, p_from_hash);
  return 'queued';
end
$$;

-- Ends a message: its content goes, and the outcome is audited as the system's.
create function apps.end_inbound_email(p_id uuid, p_status text, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  was text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  ws uuid;
  channel uuid;
begin
  update apps.inbound_email
     set status = p_status, reason = p_reason, raw = null, lease = null,
         processed_at = pg_catalog.now()
   where id = p_id and status = 'queued'
  returning workspace_id, channel_id into ws, channel;
  if ws is null then
    return;
  end if;
  perform pg_catalog.set_config('app.workspace_id', ws::text, true);
  perform admin.append_audit_event('email.inbound_' || p_status, 'system', null,
    'intake_channel', channel::text, pg_catalog.jsonb_build_object('reason', p_reason));
  perform pg_catalog.set_config('app.workspace_id', was, true);
end
$$;

-- One message at a time: the workspace served longest ago first, its oldest message first, so
-- one with much waiting does not delay another. No more than `p_per_hour` are taken from a
-- workspace in any hour; what was refused does not count towards that.
create function apps.claim_inbound_email(p_lease_seconds integer, p_per_hour integer,
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

-- Records who a message says it is from and which it is, before anything is filed.
create function apps.begin_inbound_email(p_id uuid, p_lease uuid, p_from_hash bytea,
                                         p_message_hash bytea, p_sender_per_hour integer)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  channel uuid;
begin
  select e.channel_id into channel from apps.inbound_email e
   where e.id = p_id and e.lease = p_lease and e.status = 'queued' for update;
  if channel is null then
    return 'lost';
  end if;
  if (select count(*) from apps.inbound_email e
       where e.channel_id = channel and e.from_hash = p_from_hash and e.status = 'accepted'
         and e.processed_at > pg_catalog.now() - interval '1 hour') >= p_sender_per_hour then
    return 'defer';
  end if;
  begin
    update apps.inbound_email set from_hash = p_from_hash, message_hash = p_message_hash
     where id = p_id;
  exception when unique_violation then
    return 'duplicate';
  end;
  return 'ok';
end
$$;

-- Which parts an earlier, interrupted pass already filed.
create function apps.inbound_email_parts(p_id uuid) returns setof integer
language sql stable security definer set search_path = '' as $$
  select a.part_no from apps.intake_attachment a where a.inbound_email_id = p_id
$$;

-- Tries again later. A wait that is nobody's fault does not use up an attempt.
create function apps.postpone_inbound_email(p_id uuid, p_lease uuid, p_seconds integer,
                                            p_counts boolean) returns void
language sql volatile security definer set search_path = '' as $$
  update apps.inbound_email
     set next_attempt_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_seconds),
         attempts = attempts - case when p_counts then 0 else 1 end,
         lease = null
   where id = p_id and lease = p_lease and status = 'queued'
$$;

create function apps.refuse_inbound_email(p_id uuid, p_lease uuid, p_status text,
                                          p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_status not in ('rejected', 'failed') then
    raise exception 'not an outcome' using errcode = '22023';
  end if;
  perform 1 from apps.inbound_email e where e.id = p_id and e.lease = p_lease for update;
  if found then
    perform apps.end_inbound_email(p_id, p_status, p_reason);
  end if;
end
$$;

-- Makes the request and gives it the files, all at once. The sender is a requester and nothing
-- else: no matter, assignee, type or user comes from the message.
create function apps.file_inbound_email(p_id uuid, p_lease uuid, p_name text, p_email text,
                                        p_attachments integer) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  was text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  message apps.inbound_email;
  requester uuid;
  request uuid;
begin
  select * into message from apps.inbound_email e
   where e.id = p_id and e.lease = p_lease and e.status = 'queued'
     and e.message_hash is not null for update;
  if message.id is null then
    return null;
  end if;
  insert into apps.intake_requester (workspace_id, channel, external_user_id, display_name, email)
  values (message.workspace_id, 'email', p_email, p_name, p_email)
  on conflict (workspace_id, channel, external_user_id) do nothing;
  select r.id into requester from apps.intake_requester r
   where r.workspace_id = message.workspace_id and r.channel = 'email'
     and r.external_user_id = p_email;
  request := core.uuid7();
  insert into apps.intake_request (id, workspace_id, channel, external_ref, requester_id,
    requester_name, requester_email, status)
  values (request, message.workspace_id, 'email',
          'email:' || pg_catalog.encode(message.message_hash, 'hex'), requester, p_name,
          p_email, 'unclassified');
  update apps.intake_attachment set request_id = request
   where inbound_email_id = p_id and request_id is null;
  insert into apps.intake_event (workspace_id, request_id, kind, actor_type, details)
  values (message.workspace_id, request, 'inbound', 'requester',
          pg_catalog.jsonb_build_object('channel', 'email', 'attachments', p_attachments));
  update apps.inbound_email
     set status = 'accepted', raw = null, lease = null, processed_at = pg_catalog.now(),
         request_id = request, attachment_count = p_attachments
   where id = p_id;
  perform pg_catalog.set_config('app.workspace_id', message.workspace_id::text, true);
  perform admin.append_audit_event('intake.request.created', 'system', null, 'intake_request',
    request::text, pg_catalog.jsonb_build_object('channel', 'email',
      'attachments', p_attachments, 'channel_id', message.channel_id));
  perform pg_catalog.set_config('app.workspace_id', was, true);
  return request;
end
$$;

alter function apps.open_email_channel(text) owner to legallabs_definer;
alter function apps.receive_inbound_email(uuid, bytea, bytea, text) owner to legallabs_definer;
alter function apps.end_inbound_email(uuid, text, text) owner to legallabs_definer;
alter function apps.claim_inbound_email(integer, integer, integer, uuid[])
  owner to legallabs_definer;
alter function apps.begin_inbound_email(uuid, uuid, bytea, bytea, integer)
  owner to legallabs_definer;
alter function apps.inbound_email_parts(uuid) owner to legallabs_definer;
alter function apps.postpone_inbound_email(uuid, uuid, integer, boolean)
  owner to legallabs_definer;
alter function apps.refuse_inbound_email(uuid, uuid, text, text) owner to legallabs_definer;
alter function apps.file_inbound_email(uuid, uuid, text, text, integer)
  owner to legallabs_definer;
revoke execute on function apps.open_email_channel(text),
  apps.receive_inbound_email(uuid, bytea, bytea, text), apps.end_inbound_email(uuid, text, text),
  apps.claim_inbound_email(integer, integer, integer, uuid[]),
  apps.begin_inbound_email(uuid, uuid, bytea, bytea, integer), apps.inbound_email_parts(uuid),
  apps.postpone_inbound_email(uuid, uuid, integer, boolean),
  apps.refuse_inbound_email(uuid, uuid, text, text),
  apps.file_inbound_email(uuid, uuid, text, text, integer) from public;
grant execute on function apps.open_email_channel(text),
  apps.receive_inbound_email(uuid, bytea, bytea, text),
  apps.claim_inbound_email(integer, integer, integer, uuid[]),
  apps.begin_inbound_email(uuid, uuid, bytea, bytea, integer), apps.inbound_email_parts(uuid),
  apps.postpone_inbound_email(uuid, uuid, integer, boolean),
  apps.refuse_inbound_email(uuid, uuid, text, text),
  apps.file_inbound_email(uuid, uuid, text, text, integer) to legallabs_worker;
