import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

const appTables = `
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'p')
   and n.nspname not in ('pg_catalog', 'information_schema', 'public', 'drizzle')
   and n.nspname not like 'pg_%'`;

// Public law shared by all workspaces is marked, and is tested below as read-only instead.
const notShared = "and coalesce(obj_description(c.oid, 'pg_class'), '') <> 'legallabs:shared'";

// Every table in an application schema, so a new table is covered the moment it exists.
async function tables(
  tx: Tx,
): Promise<{ schema: string; table: string; tenant: string; readable: boolean }[]> {
  return tx.rows(
    `select n.nspname as schema, c.relname as table,
            case when (n.nspname, c.relname) = ('core', 'workspace') then 'id' else 'workspace_id' end as tenant,
            has_table_privilege('legallabs_app', c.oid, 'select') as readable
     ${appTables} ${notShared} and not c.relispartition order by 1, 2`,
  );
}

// A table the app has no grant on cannot leak through it, so there is nothing to scan.
const appReadable = async (tx: Tx) => (await tables(tx)).filter((t) => t.readable);

const qualified = (t: { schema: string; table: string }) => `"${t.schema}"."${t.table}"`;

async function unprotectedTables(tx: Tx): Promise<string[]> {
  const rows = await tx.rows<{ name: string }>(
    `select n.nspname || '.' || c.relname as name ${appTables}
       and (not c.relrowsecurity or not c.relforcerowsecurity
            or not exists (select 1 from pg_policy p where p.polrelid = c.oid))
     order by 1`,
  );
  return rows.map((r) => r.name);
}

describe("row-level security coverage", () => {
  it("is enabled, forced and has policies on every table", async () => {
    await withTx(async (tx) => {
      expect(await unprotectedTables(tx)).toEqual([]);
    });
  });

  it("catches a table added without protection", async () => {
    await withTx(async (tx) => {
      await tx.rows("create table core.forgotten (id int)");
      expect(await unprotectedTables(tx)).toEqual(["core.forgotten"]);
    });
  });

  it("gives every table a required workspace_id", async () => {
    await withTx(async (tx) => {
      const missing: string[] = [];
      for (const t of await tables(tx)) {
        const col = await tx.rows(
          `select 1 from information_schema.columns
            where table_schema = $1 and table_name = $2 and column_name = $3 and is_nullable = 'NO'`,
          [t.schema, t.table, t.tenant],
        );
        if (col.length === 0) missing.push(`${t.schema}.${t.table}`);
      }
      expect(missing).toEqual([]);
    });
  });

  it("lets the app only read shared tables, and only as a member", async () => {
    await withTx(async (tx) => {
      const shared = await tx.rows<{ name: string; writable: boolean }>(
        `select n.nspname || '.' || c.relname as name,
                has_table_privilege('legallabs_app', c.oid, 'insert, update, delete, truncate')
                  as writable
           ${appTables} and obj_description(c.oid, 'pg_class') = 'legallabs:shared'
          order by 1`,
      );
      expect(shared.length).toBeGreaterThan(0);
      expect(shared.filter((t) => t.writable)).toEqual([]);
      await tx.rows(
        `insert into knowledge.authority (ref, source, title, content_hash)
         values ('us_caselaw:cap:1', 'us_caselaw', 'A v. B', repeat('0', 64))`,
      );
      await tx.as(null, null);
      const { count } = await tx.one<{ count: string }>("select count(*) from knowledge.authority");
      expect(Number(count)).toBe(0);
    });
  });

  it("keeps the migrations ledger out of the app's reach", async () => {
    await withTx(async (tx) => {
      const { usage } = await tx.one<{ usage: boolean }>(
        "select has_schema_privilege('legallabs_app', 'drizzle', 'usage') as usage",
      );
      expect(usage).toBe(false);
    });
  });

  it("returns no rows from any table when the request sets no user", async () => {
    await withTx(async (tx) => {
      await seed(tx);
      const list = await appReadable(tx);
      await tx.as(null, null);
      for (const t of list) {
        const { count } = await tx.one<{ count: string }>(`select count(*) from ${qualified(t)}`);
        expect({ table: t.table, count: Number(count) }).toEqual({ table: t.table, count: 0 });
      }
    });
  });

  it("never shows one workspace's rows to another, on any table", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const list = await appReadable(tx);
      const betaRows = (t: (typeof list)[number]) =>
        tx.one<{ count: string }>(`select count(*) from ${qualified(t)} where ${t.tenant} = $1`, [
          s.beta,
        ]);
      for (const t of list) {
        // The fixture must reach every table, or this test proves nothing for it.
        expect({ table: t.table, seeded: Number((await betaRows(t)).count) > 0 }).toEqual({
          table: t.table,
          seeded: true,
        });
      }
      await tx.as(s.ana, s.acme);
      for (const t of list) {
        expect({ table: t.table, count: Number((await betaRows(t)).count) }).toEqual({
          table: t.table,
          count: 0,
        });
      }
    });
  });
});
