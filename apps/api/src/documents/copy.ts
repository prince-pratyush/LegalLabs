import type pg from "pg";

/**
 * Whether the caller may take a copy of text from these documents, as things stand now: a vault
 * that forbids copies or downloads forbids it to everyone but its owner.
 */
export async function mayCopy(db: pg.PoolClient, documents: readonly string[]): Promise<boolean> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int n
       from content.document d
       left join content.vault v on v.id = d.vault_id
      where d.id = any ($1::uuid[])
        and (v.id is null
             or (content.vault_level(v.id) is distinct from 'owner'
                 and (v.content_controls ->> 'allow_download' = 'false'
                      or v.content_controls ->> 'allow_duplicate' = 'false')))`,
    [documents],
  );
  return rows[0]?.n === 0;
}

/**
 * Whether the caller may take a file made from these documents: each must still be readable to
 * them, and no vault holding one may forbid it. An unreadable one can't be asked, so it refuses.
 */
export async function mayTake(db: pg.PoolClient, documents: readonly string[]): Promise<boolean> {
  const { rows } = await db.query<{ id: string; vault_id: string | null }>(
    "select id, vault_id from content.document where id = any($1::uuid[])",
    [documents],
  );
  if (rows.length !== new Set(documents).size) return false;
  // Only vaults carry copy controls.
  const filed = rows.flatMap((row) => (row.vault_id ? [row.id] : []));
  return filed.length === 0 || mayCopy(db, filed);
}

/**
 * Whether words from this thread may be copied out by the caller: every file it holds, cites, was
 * made from or gave to a model, and every vault in its scope, as things stand now.
 */
export async function mayLeaveThread(db: pg.PoolClient, threadId: string): Promise<boolean> {
  // A held or cited version that can't be read can't be asked about its controls.
  const { rows } = await db.query<{ id: string | null }>(
    `select v.document_id id
       from (select version_id from work.thread_document where thread_id = $1
             union
             select c.version_id from work.citation c
               join work.message m on m.id = c.message_id
              where m.thread_id = $1 and c.kind = 'document') held
       left join content.document_version v on v.id = held.version_id
     union all
     select unnest(source_documents) from work.thread where id = $1
     union all
     select unnest(read_documents) from work.message where thread_id = $1`,
    [threadId],
  );
  const ids = rows.map((row) => row.id);
  if (ids.includes(null)) return false;
  if (!(await mayTake(db, [...new Set(ids as string[])]))) return false;
  // A vault searched without a citation is part of the thread too.
  const { rows: vaults } = await db.query<{ closed: boolean }>(
    `select exists (
       select 1 from work.thread t
        cross join unnest(t.vault_ids) held(id)
         left join content.vault v on v.id = held.id
        where t.id = $1
          and (v.id is null
               or (content.vault_level(v.id) is distinct from 'owner'
                   and (v.content_controls ->> 'allow_download' = 'false'
                        or v.content_controls ->> 'allow_duplicate' = 'false')))) closed`,
    [threadId],
  );
  return !vaults[0]?.closed;
}
