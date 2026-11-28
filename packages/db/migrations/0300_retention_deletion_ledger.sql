-- What was deleted, and when, so that restoring a backup can delete it again (SEC-030).
-- Ids only: no names and no content. Written by triggers, so no path that deletes can forget.
create table retention.deletion_ledger (
  id uuid primary key default core.uuid7(),
  -- No foreign key: the row outlives whatever it names, the workspace included.
  workspace_id uuid not null,
  object_type text not null
    check (object_type in ('document', 'folder', 'vault', 'thread', 'review_table')),
  object_id uuid not null,
  action text not null check (action in ('binned', 'restored', 'purged')),
  -- Who and why, as the binned row recorded it; only some kinds have these.
  deleted_by uuid,
  deleted_reason text,
  at timestamptz not null default clock_timestamp()
);
create index deletion_ledger_at_idx on retention.deletion_ledger (at);

alter table retention.deletion_ledger enable row level security;
alter table retention.deletion_ledger force row level security;
grant insert on retention.deletion_ledger to legallabs_definer;
-- Written for whichever workspace the row being deleted belongs to; nobody else reads it
-- but the owner, who takes the backups.
create policy definer_write on retention.deletion_ledger for insert to legallabs_definer
  with check (true);

create function retention._record_deletion() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  what text;
  row_ws uuid;
  row_id uuid;
  row jsonb;
begin
  if tg_op = 'DELETE' then
    what := 'purged';
    row := to_jsonb(old);
  else
    what := case when new.deleted_at is null then 'restored' else 'binned' end;
    row := to_jsonb(new);
  end if;
  row_ws := (row ->> 'workspace_id')::uuid;
  row_id := (row ->> 'id')::uuid;
  insert into retention.deletion_ledger
    (workspace_id, object_type, object_id, action, deleted_by, deleted_reason)
  values (row_ws, tg_argv[0], row_id, what,
          case when what = 'binned' then (row ->> 'deleted_by')::uuid end,
          case when what = 'binned' then row ->> 'deleted_reason' end);
  return null;
end
$$;
alter function retention._record_deletion() owner to legallabs_definer;

create trigger ledger_purged after delete on content.document
  for each row execute function retention._record_deletion('document');
create trigger ledger_binned after update of deleted_at on content.document
  for each row when (old.deleted_at is distinct from new.deleted_at)
  execute function retention._record_deletion('document');

create trigger ledger_purged after delete on content.folder
  for each row execute function retention._record_deletion('folder');
create trigger ledger_binned after update of deleted_at on content.folder
  for each row when (old.deleted_at is distinct from new.deleted_at)
  execute function retention._record_deletion('folder');

create trigger ledger_purged after delete on content.vault
  for each row execute function retention._record_deletion('vault');
create trigger ledger_binned after update of deleted_at on content.vault
  for each row when (old.deleted_at is distinct from new.deleted_at)
  execute function retention._record_deletion('vault');

create trigger ledger_purged after delete on work.thread
  for each row execute function retention._record_deletion('thread');
create trigger ledger_binned after update of deleted_at on work.thread
  for each row when (old.deleted_at is distinct from new.deleted_at)
  execute function retention._record_deletion('thread');

create trigger ledger_purged after delete on work.review_table
  for each row execute function retention._record_deletion('review_table');
create trigger ledger_binned after update of deleted_at on work.review_table
  for each row when (old.deleted_at is distinct from new.deleted_at)
  execute function retention._record_deletion('review_table');
