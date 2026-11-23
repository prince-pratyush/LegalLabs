-- Retention left traces of a purged object behind: the notification hub kept "A thread was shared
-- with you: <title>" for everyone it was sent to, and the email outbox kept the same text for
-- queued and sent mail. A deleted object's name can be as sensitive as its content, so a purge now
-- removes both. Found by the security review's residue scan (pen-test P-03).
create or replace function retention._purge_item(p_bin uuid) returns bytea[]
language plpgsql security definer set search_path = '' as $$
declare
  b retention.recycle_bin;
  hashes bytea[] := '{}';
begin
  select * into b from retention.recycle_bin x
   where x.id = p_bin and x.workspace_id = core.current_workspace_id()
     and x.purged_at is null and x.restored_at is null for update;
  if b.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if b.object_type = 'thread' then
    delete from core.share_grant g
     where g.workspace_id = b.workspace_id and g.object_type = 'thread'
       and g.object_id = b.object_id;
    -- Messages, citations, attached versions, drafts, runs and their events cascade.
    delete from work.thread t where t.id = b.object_id and t.workspace_id = b.workspace_id;
  elsif b.object_type = 'review_table' then
    delete from core.share_grant g
     where g.workspace_id = b.workspace_id and g.object_type = 'review_table'
       and g.object_id = b.object_id;
    delete from work.review_table r where r.id = b.object_id and r.workspace_id = b.workspace_id;
  else
    select coalesce(array_agg(p.sha256), '{}') into hashes
      from content.purge(b.workspace_id, '{}', '{}', array[b.object_id]) p;
  end if;
  -- What was said about it to other people: titles live in the notification and in the mail
  -- that carried it.
  delete from notify.email_outbox o
   where o.workspace_id = b.workspace_id and o.payload::text like '%' || b.object_id::text || '%';
  delete from notify.notification n
   where n.workspace_id = b.workspace_id and n.object_id = b.object_id;
  update retention.recycle_bin x set purged_at = now() where x.id = b.id;
  return hashes;
end
$$;
