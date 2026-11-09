import { createHash } from "node:crypto";
import pg from "pg";
import { describe, expect, inject, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

interface ChainRow extends Record<string, unknown> {
  seq: string;
  prev_hash: string;
  hash: string;
  canonical: string;
}

const genesis = "00".repeat(32);

const append = (tx: Tx, action: string, details: unknown = {}) =>
  tx.rows(
    `select admin.append_audit_event($1, 'user', core.current_user_id(), 'thread', 't1', $2::jsonb)`,
    [action, JSON.stringify(details)],
  );

const chain = (tx: Tx, workspace: string) =>
  tx.rows<ChainRow>(
    `select seq, encode(prev_hash, 'hex') as prev_hash, encode(hash, 'hex') as hash, canonical
       from admin.audit_event where workspace_id = $1 order by seq`,
    [workspace],
  );

// Written apart from the SQL, so the database and an auditor's script must agree.
const expectedHash = (prev: string, canonical: string) =>
  createHash("sha256").update(Buffer.from(prev, "hex")).update(canonical, "utf8").digest("hex");

describe("audit chain", () => {
  it("links every event to the one before it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      await append(tx, "thread.created");
      await append(tx, "thread.deleted");

      const rows = await chain(tx, s.acme);
      expect(rows.map((r) => r.seq)).toEqual(["1", "2", "3"]);
      let prev = genesis;
      for (const row of rows) {
        expect(row.prev_hash).toBe(prev);
        expect(row.hash).toBe(expectedHash(prev, row.canonical));
        prev = row.hash;
      }
    });
  });

  it("keeps a separate chain for each workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.bob, s.beta);
      const rows = await chain(tx, s.beta);
      expect(rows.map((r) => r.seq)).toEqual(["1"]);
      expect(rows[0]?.prev_hash).toBe(genesis);
    });
  });

  it("hashes text that records every field of the event", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      await append(tx, "thread.created", { messages: 2 });

      const row = (await chain(tx, s.acme)).at(-1);
      expect(JSON.parse(row?.canonical ?? "")).toMatchObject({
        workspace_id: s.acme,
        seq: 2,
        actor_type: "user",
        actor_id: s.ana,
        action: "thread.created",
        object_type: "thread",
        object_id: "t1",
        details: { messages: 2 },
      });
    });
  });

  it("refuses an event when the request has no workspace", async () => {
    await withTx(async (tx) => {
      await tx.as(null, null);
      expect(await tx.error("select admin.append_audit_event('logout', 'system', null)")).toMatch(
        /workspace/,
      );
    });
  });

  it("refuses a malformed action name", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("select admin.append_audit_event('Nope', 'system', null)")).toMatch(
        /action/,
      );
    });
  });

  it("refuses a non-system event with no actor", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("select admin.append_audit_event('logout', 'user', null)")).toMatch(
        /actor/,
      );
    });
  });

  it("refuses details large enough to be carrying content", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      const huge = { text: "x".repeat(20_000) };
      expect(
        await tx.error(
          "select admin.append_audit_event('logout', 'system', null, null, null, $1::jsonb)",
          [JSON.stringify(huge)],
        ),
      ).toMatch(/details/);
    });
  });

  it("gives the app no way to write events except the function", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error(`insert into admin.audit_event (workspace_id) values ($1)`, [s.acme]),
      ).toMatch(/permission denied/);
      expect(await tx.error("update admin.audit_head set seq = 0")).toMatch(/permission denied/);
    });
  });

  it("shows events only to holders of admin.audit", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      expect(await chain(tx, s.acme)).toEqual([]);
      await tx.as(s.ana, s.acme);
      expect((await chain(tx, s.acme)).length).toBeGreaterThan(0);
    });
  });

  it("keeps partitions out of the app's direct reach", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("select * from admin.audit_event_default")).toMatch(
        /permission denied/,
      );
    });
  });

  it("stays a single line when writers race", async () => {
    const url = inject("databaseUrl");
    const owner = new pg.Client({ connectionString: url });
    await owner.connect();
    const { rows } = await owner.query<{ id: string }>(
      `insert into core.workspace (slug, name, region)
       values ('race-' || core.uuid7(), 'race', 'au') returning id`,
    );
    const workspace = rows[0]?.id ?? "";
    await owner.end();

    const writer = async () => {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      for (let i = 0; i < 10; i++) {
        await client.query("begin");
        await client.query("set local role legallabs_app");
        await client.query("select set_config('app.workspace_id', $1, true)", [workspace]);
        await client.query("select admin.append_audit_event('retention.sweep', 'system', null)");
        await client.query("commit");
      }
      await client.end();
    };
    await Promise.all([writer(), writer(), writer()]);

    await withTx(async (tx) => {
      const rows = await chain(tx, workspace);
      expect(rows).toHaveLength(30);
      let prev = genesis;
      for (const row of rows) {
        expect(row.prev_hash).toBe(prev);
        prev = row.hash;
      }
    });
  });
});
