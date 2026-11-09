import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type AuditRow, readAuditChain, verifyAuditChain } from "../src/audit.js";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

const genesis = "00".repeat(32);
const sha = (prev: string, canonical: string) =>
  createHash("sha256").update(Buffer.from(prev, "hex")).update(canonical, "utf8").digest("hex");
const failure = (seq: number, reason: RegExp) => ({
  ok: false,
  seq,
  reason: expect.stringMatching(reason),
});

function buildChain(actions: string[]): AuditRow[] {
  let prev = genesis;
  return actions.map((action, i) => {
    const fields = {
      workspace_id: "w1",
      seq: i + 1,
      at: `2026-11-0${i + 1}T00:00:00.000000Z`,
      actor_type: "system",
      actor_id: null,
      action,
      object_type: null,
      object_id: null,
      details: { n: i },
      ip: null,
      ua_hash: null,
    };
    const canonical = JSON.stringify(fields);
    const row = { ...fields, prev_hash: prev, hash: sha(prev, canonical), canonical };
    prev = row.hash;
    return row;
  });
}

const reader = (tx: Tx) => ({
  query: async (sql: string, params: unknown[]) => ({ rows: await tx.rows(sql, params) }),
});

describe("audit verifier", () => {
  it("accepts an untouched chain", () => {
    expect(verifyAuditChain(buildChain(["a.b", "c.d", "e.f"]))).toEqual({ ok: true, events: 3 });
  });

  it("spots a column that no longer matches what was hashed", () => {
    const rows = buildChain(["a.b", "c.d"]);
    rows[0] = { ...(rows[0] as AuditRow), action: "x.y" };
    expect(verifyAuditChain(rows)).toEqual(failure(1, /action/));
  });

  it("spots edited hashed text", () => {
    const rows = buildChain(["a.b"]);
    const row = rows[0] as AuditRow;
    rows[0] = { ...row, canonical: row.canonical.replace("a.b", "x.y") };
    expect(verifyAuditChain(rows)).toEqual(failure(1, /hash/));
  });

  it("spots a recomputed hash, because the next event no longer links", () => {
    const rows = buildChain(["a.b", "c.d"]);
    const row = rows[0] as AuditRow;
    const canonical = row.canonical.replace("a.b", "x.y");
    rows[0] = { ...row, action: "x.y", canonical, hash: sha(genesis, canonical) };
    expect(verifyAuditChain(rows)).toEqual(failure(2, /link/));
  });

  it("spots a deleted event", () => {
    const rows = buildChain(["a.b", "c.d", "e.f"]);
    rows.splice(1, 1);
    expect(verifyAuditChain(rows)).toEqual(failure(3, /missing/));
  });

  it("spots a chain that does not start at the beginning", () => {
    expect(verifyAuditChain(buildChain(["a.b", "c.d"]).slice(1))).toEqual(failure(2, /missing/));
  });

  it("needs an anchor to catch a chain rewritten from scratch", () => {
    const real = buildChain(["a.b", "c.d"]);
    const forged = buildChain(["a.b", "x.y"]);
    const anchor = { day: "2026-11-02", last_seq: 2, last_hash: (real[1] as AuditRow).hash };
    expect(verifyAuditChain(forged).ok).toBe(true);
    expect(verifyAuditChain(forged, [anchor])).toEqual(failure(2, /anchor/));
  });

  it("uses anchors to catch events removed from the end", () => {
    const rows = buildChain(["a.b", "c.d"]);
    const anchor = { day: "2026-11-02", last_seq: 2, last_hash: (rows[1] as AuditRow).hash };
    expect(verifyAuditChain(rows.slice(0, 1), [anchor])).toEqual(failure(2, /anchor/));
  });
});

describe("tamper detection against the database", () => {
  async function seededChain(tx: Tx) {
    const s = await seed(tx);
    await tx.as(s.ana, s.acme);
    await tx.rows(
      `select admin.append_audit_event('share.granted', 'user', $1, 'thread', 't1',
              '{"level": "view"}'::jsonb, '203.0.113.9'::inet, 'abc123')`,
      [s.ana],
    );
    await tx.rows("select admin.append_audit_event('logout', 'user', $1)", [s.ana]);
    await tx.asOwner();
    return s;
  }

  it("verifies events written by the real function", async () => {
    await withTx(async (tx) => {
      const s = await seededChain(tx);
      const rows = await readAuditChain(reader(tx), s.acme);
      expect(verifyAuditChain(rows)).toEqual({ ok: true, events: 3 });
    });
  });

  it("detects a modified row", async () => {
    await withTx(async (tx) => {
      const s = await seededChain(tx);
      // A superuser can switch triggers off; the chain has to catch what follows.
      await tx.rows("set local session_replication_role = replica");
      await tx.rows(
        `update admin.audit_event set details = '{"level": "full"}'
          where workspace_id = $1 and seq = 2`,
        [s.acme],
      );
      await tx.rows("set local session_replication_role = origin");
      const rows = await readAuditChain(reader(tx), s.acme);
      expect(verifyAuditChain(rows)).toEqual(failure(2, /details/));
    });
  });
});
