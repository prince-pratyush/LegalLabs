import type { Caller, VaultPort } from "@legallabs/contracts";
import type pg from "pg";
import { asApp } from "../db.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 10_000;

/**
 * What threads needs from vaults. Every query runs as the caller, so row security applies
 * the vault grants, the walls and the recycle bin. For search, prefer the `vault_ids` scope:
 * it narrows inside the query instead of passing thousands of ids.
 */
export function createVaultPort(pool: pg.Pool): VaultPort {
  const identity = (caller: Caller) => ({ userId: caller.userId, workspaceId: caller.workspaceId });
  return {
    async list(caller) {
      return asApp(pool, identity(caller), async (db) => {
        const { rows } = await db.query<{ id: string; name: string; file_count: string }>(
          `select v.id, v.name,
                  (select count(*) from content.document d where d.vault_id = v.id) file_count
             from content.vault v
            where v.deleted_at is null and content.vault_level(v.id) is not null
            order by v.updated_at desc, v.id desc limit 500`,
        );
        return rows.map((row) => ({
          id: row.id,
          name: row.name,
          file_count: Number(row.file_count),
        }));
      });
    },

    async documentIds(caller, vaultIds, limit) {
      const ids = vaultIds.filter((id) => UUID.test(id));
      const take = Math.min(Math.max(Math.trunc(limit) || 0, 0), MAX_IDS);
      if (ids.length === 0 || take === 0) return [];
      return asApp(pool, identity(caller), async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `select d.id from content.document d
            where d.vault_id = any($1::uuid[])
            order by d.id limit $2`,
          [ids, take],
        );
        return rows.map((row) => row.id);
      });
    },
  };
}
