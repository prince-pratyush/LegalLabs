import { readAuditChain, verifyAuditChain } from "@legallabs/db";
import { createMemoryStore } from "@legallabs/storage";
import { afterAll, describe, expect, it } from "vitest";
import { asApp } from "../db.js";
import { seedMember, testPool } from "../test-db.js";
import { createAnchorJob } from "./anchor-job.js";

/*
 * Pen-test P-11 (SEC-041): the audit chain has to be checkable against something the database
 * cannot rewrite. The anchor job is what puts each finished day's last hash outside it.
 */

const pool = testPool();
afterAll(() => pool.end());

// Events can only be stamped now, so a past day is made by moving them.
async function eventsDaysAgo(workspaceId: string, days: number) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    await db.query(
      `update admin.audit_event set at = at - make_interval(days => $2) where workspace_id = $1`,
      [workspaceId, days],
    );
    await db.query("commit");
  } finally {
    db.release();
  }
}

async function chain(userId: string, workspaceId: string) {
  return asApp(pool, { userId, workspaceId }, (db) => readAuditChain(db, workspaceId));
}

describe("P-11 daily audit anchors", () => {
  it("writes a finished day's last hash to storage, once, and it verifies the chain", async () => {
    const m = await seedMember(pool);
    // Something to record: the app's own events for a workspace (a refused sign-in is one).
    await asApp(pool, { userId: m.userId, workspaceId: m.workspaceId }, (db) =>
      db.query("select admin.append_audit_event('logout', 'user', $1)", [m.userId]),
    );
    await eventsDaysAgo(m.workspaceId, 2);

    const store = createMemoryStore();
    const job = createAnchorJob(pool, { store });
    const first = await job.runOnce();
    expect(first.failed).toBe(0);
    expect(first.anchored).toBeGreaterThan(0);

    const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const key = `audit-anchors/${m.workspaceId}/${day}.json`;
    const body = await store.get(key);
    expect(body).not.toBeNull();
    const anchor = JSON.parse(new TextDecoder().decode(body as Uint8Array));
    const rows = await chain(m.userId, m.workspaceId);
    expect(anchor).toMatchObject({ workspace_id: m.workspaceId, day });
    // The anchor names the chain's hash at its last event of that day.
    expect(rows[anchor.last_seq - 1]?.hash).toBe(anchor.last_hash);

    // A pass is safe to repeat, and never changes what was written.
    const again = await job.runOnce();
    expect(again.failed).toBe(0);
    expect(new TextDecoder().decode((await store.get(key)) as Uint8Array)).toBe(
      JSON.stringify(anchor),
    );

    // A chain cut back past that event no longer reaches the anchor: the verifier reports it.
    const cut = verifyAuditChain(rows.slice(0, anchor.last_seq - 1), [anchor]);
    expect(cut.ok).toBe(false);
  });

  it("only the worker role may list workspaces", async () => {
    await expect(
      asApp(pool, { userId: null, workspaceId: null }, (db) =>
        db.query("select admin.anchor_workspaces()"),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
