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
