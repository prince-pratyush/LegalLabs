import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { asApp } from "../db.js";
import { seedMember, testPool } from "../test-db.js";
import { track, trackOutcome, trackUsage } from "./record.js";

const pool = testPool();
afterAll(() => pool.end());
afterEach(() => vi.restoreAllMocks());

const query = { surface: "web", action: "thread.message_sent", actionClass: "query" } as const;

async function workspace() {
  const ws = await seedMember(pool, { permissions: ["threads.use"] });
  const who = { userId: ws.userId, workspaceId: ws.workspaceId };
  const count = async (table: "usage_event" | "outcome_event") =>
    (
      await pool.query<{ n: number }>(
        `select count(*)::int n from analytics.${table} where workspace_id = $1`,
        [ws.workspaceId],
      )
    ).rows[0]?.n;
  return { ws, who, count };
}

describe("recording from features", () => {
  it("counts a keyed event once, however often it is repeated, per workspace", async () => {
    const a = await workspace();
    const b = await workspace();
    for (const w of [a, a, b]) {
      await asApp(pool, w.who, async (db) => {
        await trackUsage(db, { ...query, once: "apply:1" });
        await trackOutcome(db, { workflowType: "redline_applied", once: "redline:1" });
      });
    }
    expect(await a.count("usage_event")).toBe(1);
    expect(await a.count("outcome_event")).toBe(1);
    // The same key in another workspace is another thing.
    expect(await b.count("usage_event")).toBe(1);
  });

  it("measures turnaround from when the originating object was made", async () => {
    const { ws, who } = await workspace();
    await asApp(pool, who, (db) =>
      trackOutcome(db, {
        workflowType: "draft_exported",
        since: new Date(Date.now() - 3_600_000),
      }),
    );
    const { rows } = await pool.query<{ s: number }>(
      "select turnaround_seconds s from analytics.outcome_event where workspace_id = $1",
      [ws.workspaceId],
    );
    expect(rows[0]?.s).toBeGreaterThanOrEqual(3600);
    expect(rows[0]?.s).toBeLessThan(3700);
  });

  it("logs a failed write and leaves the caller's work to commit", async () => {
    const { ws, who, count } = await workspace();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await asApp(pool, who, async (db) => {
      await db.query('update core."user" set name = $2 where id = $1', [ws.userId, "Kept"]);
      // Refused by the table's check on action names.
      await trackUsage(db, { ...query, action: "Not Allowed", once: "failed:1" });
      await db.query("select 1");
    });
    expect(logged).toHaveBeenCalledOnce();
    expect(await count("usage_event")).toBe(0);
    // The key was not used up, so the next try still counts.
    await asApp(pool, who, (db) => trackUsage(db, { ...query, once: "failed:1" }));
    expect(await count("usage_event")).toBe(1);
  });

  it("never throws when it has to open its own transaction", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const nobody = { userId: null, workspaceId: null };
    await expect(
      track(pool, nobody, async () => {
        throw new Error("database is away");
      }),
    ).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledOnce();
  });
});
