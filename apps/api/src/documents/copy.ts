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
