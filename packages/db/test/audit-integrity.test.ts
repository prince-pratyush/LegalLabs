import pg from "pg";
import { describe, expect, inject, it } from "vitest";
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

describe("anchoring a day", () => {
  it("waits for events still being written", async () => {
    const url = inject("databaseUrl");
    const owner = new pg.Client({ connectionString: url });
    const writer = new pg.Client({ connectionString: url });
    const anchorer = new pg.Client({ connectionString: url });
    await Promise.all([owner.connect(), writer.connect(), anchorer.connect()]);
    try {
      const { rows } = await owner.query<{ id: string }>(
        `insert into core.workspace (slug, name, region)
         values ('anchor-' || core.uuid7(), 'anchor', 'au') returning id`,
      );
      const workspace = rows[0]?.id ?? "";
      const enter = async (client: pg.Client) => {
        await client.query("begin");
        await client.query("set local role legallabs_app");
        await client.query("select set_config('app.workspace_id', $1, true)", [workspace]);
      };
      const appendEvent = () =>
        writer.query("select admin.append_audit_event('retention.sweep', 'system', null)");
      await enter(writer);
      await appendEvent();
      await writer.query("commit");
      await enter(writer);
      await appendEvent();
      await enter(anchorer);
      await anchorer.query("set local lock_timeout = '200ms'");
      await expect(
        anchorer.query("select * from admin.record_audit_anchor('2020-01-01')"),
      ).rejects.toThrow(/lock timeout/);
    } finally {
      await writer.query("rollback");
      await anchorer.query("rollback");
      await Promise.all([owner.end(), writer.end(), anchorer.end()]);
    }
  });
});

describe("who an event can name", () => {
  const append = "select admin.append_audit_event($1, $2, $3, null, $4, $5::jsonb)";

  it("refuses naming someone other than the current user", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await tx.error(append, ["logout", "user", s.ben, null, "{}"])).toMatch(/actor/);
    });
  });

  it("refuses a workspace the current user is not in", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.beta);
      expect(await tx.error(append, ["logout", "user", s.ana, null, "{}"])).toMatch(/outside/);
    });
  });

  it("makes an agent record whose behalf it acts on", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      const onBehalf = JSON.stringify({ on_behalf_of: s.ana });
      expect(await tx.error(append, ["tool.call", "agent", s.ana, null, "{}"])).toMatch(
        /on_behalf_of/,
      );
      expect(await tx.error(append, ["tool.call", "agent", s.ana, null, onBehalf])).toBeUndefined();
    });
  });

  it("refuses an object id long enough to be carrying content", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await tx.error(append, ["logout", "user", s.ana, "x".repeat(300), "{}"])).toMatch(
        /object/,
      );
    });
  });
});

describe("deleting a workspace", () => {
  it("works when it has no audit history, and is refused when it has", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.asOwner();
      const { id } = await tx.one<{ id: string }>(
        `insert into core.workspace (slug, name, region)
         values ('empty-' || core.uuid7(), 'empty', 'au') returning id`,
      );
      expect(await tx.error("delete from core.workspace where id = $1", [id])).toBeUndefined();
      expect(await tx.error("delete from core.workspace where id = $1", [s.beta])).toMatch(
        /foreign key/,
      );
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
        `select has_table_privilege('legallabs_definer', 'admin.audit_event', 'delete, truncate') as allowed`,
      );
      expect(allowed).toBe(false);
    });
  });
});
