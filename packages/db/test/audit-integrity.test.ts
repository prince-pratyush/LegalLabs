import { describe, expect, it } from "vitest";
import { withTx } from "./db.js";
import { seed } from "./fixtures.js";

describe("monthly audit partitions", () => {
  const nextMonthPartition = `'admin.audit_event_y' || to_char(now() at time zone 'UTC' + interval '1 month', 'YYYY"m"MM')`;

  it("exist ahead of time, and calling again changes nothing", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      await tx.rows("select admin.ensure_audit_partitions()");
      await tx.rows("select admin.ensure_audit_partitions()");
      await tx.asOwner();
      const { found } = await tx.one<{ found: string | null }>(
        `select to_regclass(${nextMonthPartition})::text as found`,
      );
      expect(found).not.toBeNull();
    });
  });

  it("store new events in the current month, not the catch-all", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.asOwner();
      const { partition } = await tx.one<{ partition: string }>(
        "select tableoid::regclass::text as partition from admin.audit_event where workspace_id = $1 limit 1",
        [s.acme],
      );
      expect(partition).toMatch(/^admin\.audit_event_y\d{4}m\d{2}$/);
    });
  });

  it("get the same protection as the catch-all", async () => {
    await withTx(async (tx) => {
      await seed(tx);
      await tx.asOwner();
      const { name } = await tx.one<{ name: string }>(`select ${nextMonthPartition} as name`);
      expect(await tx.error(`truncate ${name}`)).toMatch(/audit records cannot be changed/);
    });
  });
});

describe("database functions", () => {
  it("are never open to every role", async () => {
    await withTx(async (tx) => {
      const open = await tx.rows<{ name: string }>(
        `select n.nspname || '.' || p.proname as name
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('core', 'admin')
            and (p.proacl is null or exists (
              select 1 from aclexplode(p.proacl) a
               where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
          order by 1`,
      );
      expect(open).toEqual([]);
    });
  });

  it("keep the partition helper from the app", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("select admin.protect_audit_partition('audit_head')")).toMatch(
        /permission denied/,
      );
    });
  });
});

describe("audit log is append-only", () => {
  it("denies the app any change", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("update admin.audit_event set action = 'x.y'")).toMatch(
        /permission denied/,
      );
      expect(await tx.error("delete from admin.audit_event")).toMatch(/permission denied/);
      expect(await tx.error("truncate admin.audit_event")).toMatch(/permission denied/);
    });
  });

  it("stops even the database owner with a trigger", async () => {
    await withTx(async (tx) => {
      await seed(tx);
      await tx.asOwner();
      const message = /audit records cannot be changed/;
      expect(await tx.error("update admin.audit_event set action = 'x.y'")).toMatch(message);
      expect(await tx.error("delete from admin.audit_event")).toMatch(message);
      expect(await tx.error("truncate admin.audit_event")).toMatch(message);
      expect(await tx.error("truncate admin.audit_event_default")).toMatch(message);
    });
  });

  it("removes change rights from the role that owns the table", async () => {
    await withTx(async (tx) => {
      const { allowed } = await tx.one<{ allowed: boolean }>(
        `select has_table_privilege('legallabs_definer', 'admin.audit_event', 'update, delete, truncate') as allowed`,
      );
      expect(allowed).toBe(false);
    });
  });
});
