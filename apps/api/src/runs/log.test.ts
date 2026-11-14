import { afterAll, describe, expect, it } from "vitest";
import type { Principal } from "../auth/auth.js";
import { seedMember, testPool } from "../test-db.js";
import { createRunLog } from "./log.js";

const pool = testPool();
afterAll(() => pool.end());

async function runFor(principal: Principal) {
  const one = async (sql: string, params: unknown[]) =>
    (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";
  const thread = await one(
    "insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 'Q') returning id",
    [principal.workspaceId, principal.userId],
  );
  const question = await one(
    `insert into work.message (workspace_id, thread_id, role, content)
     values ($1, $2, 'user', 'Q') returning id`,
    [principal.workspaceId, thread],
  );
  return one(
    `insert into work.run (workspace_id, thread_id, owner_id, kind, status, question_id)
     values ($1, $2, $3, 'thread', 'running', $4) returning id`,
    [principal.workspaceId, thread, principal.userId, question],
  );
}

const principalOf = async () => {
  const m = await seedMember(pool);
  return { sessionId: "s", userId: m.userId, workspaceId: m.workspaceId };
};

describe("run log", () => {
  it("numbers events without gaps even when appended at once, and replays after a point", async () => {
    const principal = await principalOf();
    const runId = await runFor(principal);
    const log = createRunLog(pool);
    const seen: number[] = [];
    const stop = log.subscribe(runId, (event) => seen.push(event.seq));

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        log.append(principal, runId, { type: "token", message_id: runId, delta: `${i}` }),
      ),
    );
    stop();

    const all = await log.replay(principal, runId, 0);
    expect(all.map((event) => event.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(all.map((event) => (event.type === "token" ? event.delta : ""))).toEqual(
      Array.from({ length: 12 }, (_, i) => `${i}`),
    );
    expect(seen).toEqual(all.map((event) => event.seq));
    expect((await log.replay(principal, runId, 10)).map((event) => event.seq)).toEqual([11, 12]);
  });

  it("carries on after a released run, from the saved count", async () => {
    const principal = await principalOf();
    const runId = await runFor(principal);
    const log = createRunLog(pool);
    await log.append(principal, runId, { type: "status", status: "running" });
    log.release(runId);
    const next = await log.append(principal, runId, { type: "status", status: "done" });
    expect(next.seq).toBe(2);
  });

  it("shows nothing to someone else, and a failed write doesn't block the next", async () => {
    const principal = await principalOf();
    const other = await principalOf();
    const runId = await runFor(principal);
    const log = createRunLog(pool);
    await expect(log.append(other, runId, { type: "status", status: "running" })).rejects.toThrow();
    await log.append(principal, runId, { type: "status", status: "running" });
    expect(await log.replay(other, runId, 0)).toEqual([]);
    expect(await log.replay(principal, runId, 0)).toHaveLength(1);
  });
});
