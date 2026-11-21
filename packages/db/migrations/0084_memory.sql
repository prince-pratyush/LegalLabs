-- Memory and writing styles. Memories are private to the person who holds them: there is no
-- admin or support path to read, list or export anyone else's, and the policies below name no
-- role that could. Writing styles are private too, until their owner shares one with the
-- workspace, which needs the writing_styles.share permission.
create schema memory;
grant usage on schema memory to legallabs_app, legallabs_definer, legallabs_worker;

-- Members only: guests hold no memories and no styles.
create function memory.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core."user" u
     where u.id = core.current_user_id()
       and u.workspace_id = core.current_workspace_id()
       and u.status = 'active' and u.kind = 'member')
$$;
alter function memory.is_member() owner to legallabs_definer;
grant execute on function memory.is_member() to legallabs_app, legallabs_definer;

create table memory.memory (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  user_id uuid not null,
  text text not null check (char_length(text) between 1 and 1000 and text = btrim(text)),
  source text not null check (source in ('asked', 'inferred', 'manual', 'imported')),
  category text check (char_length(category) <= 80),
  -- sha256 of the normalised text, so the same preference is never stored twice.
  normalized_hash text not null check (normalized_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, normalized_hash),
  unique (workspace_id, id),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);
create index memory_user_idx on memory.memory (user_id, created_at);

-- An inferred preference waiting to be confirmed. Never applied until the person says so.
create table memory.memory_candidate (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  user_id uuid not null,
  message_id uuid,
  text text not null check (char_length(text) between 1 and 1000 and text = btrim(text)),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  decided_at timestamptz,
  decision text check (decision in ('accepted', 'dismissed')),
  check ((decided_at is null) = (decision is null)),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);
create index memory_candidate_user_idx on memory.memory_candidate (user_id, expires_at);

create table memory.memory_setting (
  user_id uuid primary key,
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  use_memory boolean not null default true,
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);

-- A parsed upload waiting for the person to choose rows; dropped a day later.
create table memory.memory_import (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  user_id uuid not null,
  rows jsonb not null,
  status text not null default 'parsed' check (status in ('parsed', 'committed')),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);
create index memory_import_user_idx on memory.memory_import (user_id, created_at);

-- What shaped one answer, kept apart from the message so only its author can see it: a
-- shared thread, an export or an admin never reaches these rows.
create table memory.message_use (
  message_id uuid primary key,
  workspace_id uuid not null,
  user_id uuid not null,
  memory_ids uuid[] not null default '{}' check (cardinality(memory_ids) <= 1000),
  not_applied uuid[] not null default '{}' check (cardinality(not_applied) <= 1000),
  created_ids uuid[] not null default '{}' check (cardinality(created_ids) <= 5),
  -- Kept after a style is unshared or deleted, for provenance.
  writing_style_id uuid,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, message_id) references work.message (workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, user_id) references core."user" (workspace_id, id) on delete cascade
);
create index message_use_user_idx on memory.message_use (user_id, created_at);

create table memory.writing_style (
  id uuid primary key default core.uuid7(),
  workspace_id uuid not null references core.workspace (id) on delete cascade,
  owner_id uuid not null,
  name text not null check (char_length(name) between 1 and 80),
  kind text not null check (kind in ('instructions', 'sample')),
  instructions text check (char_length(instructions) <= 5000),
  derived_instructions text check (char_length(derived_instructions) <= 2000),
  -- Kept with the style, so it goes when the owner or the style does.
  sample_text text check (char_length(sample_text) <= 50000),
  sample_pages integer check (sample_pages between 0 and 20),
  sample_chars integer check (sample_chars between 0 and 50000),
  shared boolean not null default false,
  status text not null default 'ready' check (status in ('processing', 'ready', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name),
  unique (workspace_id, id),
  check (kind = 'instructions' or sample_text is not null),
  foreign key (workspace_id, owner_id) references core."user" (workspace_id, id) on delete cascade
);
create index writing_style_shared_idx on memory.writing_style (workspace_id) where shared;

-- Caps hold under concurrent requests: the count is taken under a per-person lock.
create function memory.cap_memories() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('memory:' || new.user_id::text, 0));
  if (select count(*) from memory.memory where user_id = new.user_id) >= 1000 then
    raise exception 'LIMIT_MEMORIES' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger memory_cap before insert on memory.memory
  for each row execute function memory.cap_memories();

create function memory.cap_styles() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('style:' || new.owner_id::text, 0));
  if (select count(*) from memory.writing_style where owner_id = new.owner_id) >= 50 then
    raise exception 'LIMIT_STYLES' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function memory.cap_memories() owner to legallabs_definer;
alter function memory.cap_styles() owner to legallabs_definer;
create trigger style_cap before insert on memory.writing_style
  for each row execute function memory.cap_styles();

alter table memory.memory enable row level security;
alter table memory.memory force row level security;
alter table memory.memory_candidate enable row level security;
alter table memory.memory_candidate force row level security;
alter table memory.memory_setting enable row level security;
alter table memory.memory_setting force row level security;
alter table memory.memory_import enable row level security;
alter table memory.memory_import force row level security;
alter table memory.message_use enable row level security;
alter table memory.message_use force row level security;
alter table memory.writing_style enable row level security;
alter table memory.writing_style force row level security;

grant select, insert, delete on memory.memory to legallabs_app;
grant update (text, category, normalized_hash, updated_at) on memory.memory to legallabs_app;
grant select, insert, delete on memory.memory_candidate to legallabs_app;
grant update (text, decided_at, decision) on memory.memory_candidate to legallabs_app;
grant select, insert on memory.memory_setting to legallabs_app;
grant update (use_memory, updated_at) on memory.memory_setting to legallabs_app;
grant select, insert, delete on memory.memory_import to legallabs_app;
grant update (status) on memory.memory_import to legallabs_app;
grant select, insert, update, delete on memory.message_use to legallabs_app;
grant select, insert, delete on memory.writing_style to legallabs_app;
grant update (name, instructions, derived_instructions, status, shared, updated_at)
  on memory.writing_style to legallabs_app;

-- Memory needs the memory.use permission, held by role (the "*" role has it). Without it the
-- rows stay but are hidden, and come back when the permission does. Only the holder's own
-- rows are ever visible: there is no policy for any other reader.
create policy memory_own on memory.memory for all to legallabs_app
  using (user_id = core.current_user_id() and core.in_tenant(workspace_id)
         and memory.is_member() and core.has_permission('memory.use'))
  with check (user_id = core.current_user_id() and core.in_tenant(workspace_id)
              and memory.is_member() and core.has_permission('memory.use'));
create policy candidate_own on memory.memory_candidate for all to legallabs_app
  using (user_id = core.current_user_id() and core.in_tenant(workspace_id)
         and memory.is_member() and core.has_permission('memory.use'))
  with check (user_id = core.current_user_id() and core.in_tenant(workspace_id)
              and memory.is_member() and core.has_permission('memory.use'));
-- The toggle is readable without the permission, so Settings can say "not enabled".
create policy setting_own on memory.memory_setting for all to legallabs_app
  using (user_id = core.current_user_id() and core.in_tenant(workspace_id))
  with check (user_id = core.current_user_id() and core.in_tenant(workspace_id));
create policy import_own on memory.memory_import for all to legallabs_app
  using (user_id = core.current_user_id() and core.in_tenant(workspace_id)
         and memory.is_member() and core.has_permission('memory.use'))
  with check (user_id = core.current_user_id() and core.in_tenant(workspace_id)
              and memory.is_member() and core.has_permission('memory.use'));
create policy message_use_own on memory.message_use for all to legallabs_app
  using (user_id = core.current_user_id() and core.in_tenant(workspace_id))
  with check (user_id = core.current_user_id() and core.in_tenant(workspace_id));

-- Owners see their own; members see what is shared with the workspace. Guests see nothing.
create policy style_read on memory.writing_style for select to legallabs_app
  using (core.in_tenant(workspace_id) and memory.is_member()
         and (owner_id = core.current_user_id() or shared));
create policy style_insert on memory.writing_style for insert to legallabs_app
  with check (core.in_tenant(workspace_id) and memory.is_member()
              and owner_id = core.current_user_id() and not shared);
-- Only the owner edits. A style can only become shared by someone who holds
-- writing_styles.share; the admin's own way to take one back is memory.unshare_style.
create policy style_update on memory.writing_style for update to legallabs_app
  using (core.in_tenant(workspace_id) and memory.is_member()
         and owner_id = core.current_user_id())
  with check (core.in_tenant(workspace_id)
              and (not shared or core.has_permission('writing_styles.share')));
create policy style_delete on memory.writing_style for delete to legallabs_app
  using (core.in_tenant(workspace_id) and memory.is_member()
         and (owner_id = core.current_user_id()
              or (shared and core.has_permission('writing_styles.share'))));

-- The cap counts a person's own rows from inside the trigger, without the policy's per-row checks.
grant select on memory.memory, memory.writing_style to legallabs_definer;
create policy definer_read on memory.memory for select to legallabs_definer using (true);
create policy definer_read on memory.writing_style for select to legallabs_definer using (true);

-- Housekeeping for the worker: drops candidates 30 days after they were made (decided or
-- not) and parsed imports a day after upload. Returns what it removed.
grant select, delete on memory.memory_candidate, memory.memory_import to legallabs_definer;
create policy definer_all on memory.memory_candidate for all to legallabs_definer
  using (true) with check (true);
create policy definer_all on memory.memory_import for all to legallabs_definer
  using (true) with check (true);

create function memory.purge(p_now timestamptz default now())
returns table (candidates integer, imports integer)
language plpgsql security definer set search_path = '' as $$
declare
  c integer;
  i integer;
begin
  delete from memory.memory_candidate x where x.expires_at < p_now;
  get diagnostics c = row_count;
  delete from memory.memory_import x where x.created_at < p_now - interval '1 day';
  get diagnostics i = row_count;
  candidates := c;
  imports := i;
  return next;
end
$$;
alter function memory.purge(timestamptz) owner to legallabs_definer;
revoke execute on function memory.purge(timestamptz) from public;
grant execute on function memory.purge(timestamptz) to legallabs_worker;

-- A holder of writing_styles.share (the Admin role) may take back any shared style. The row
-- turns private again, so the update can't be a plain one: the admin may not read it after.
create function memory.unshare_style(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  if not (core.in_tenant(core.current_workspace_id()) and memory.is_member()
          and core.has_permission('writing_styles.share')) then
    raise exception 'FORBIDDEN' using errcode = 'insufficient_privilege';
  end if;
  update memory.writing_style x set shared = false, updated_at = now()
   where x.id = p_id and x.workspace_id = core.current_workspace_id() and x.shared;
  get diagnostics n = row_count;
  return n = 1;
end
$$;
alter function memory.unshare_style(uuid) owner to legallabs_definer;
revoke execute on function memory.unshare_style(uuid) from public;
grant execute on function memory.unshare_style(uuid) to legallabs_app;
grant update (shared, updated_at) on memory.writing_style to legallabs_definer;
create policy definer_update on memory.writing_style for update to legallabs_definer
  using (true) with check (true);
