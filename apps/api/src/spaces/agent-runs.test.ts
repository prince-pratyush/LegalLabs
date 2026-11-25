import { randomUUID } from "node:crypto";
import type { AgentRunPort } from "@legallabs/contracts";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentRuns } from "../agent-runs/runs.js";
import { seedMember, testPool } from "../test-db.js";
import { createTaskRuns } from "./agent-runs.js";

// The whole path runs in e2e/runs.test.ts; these are the refusals.
const pool = testPool();
afterAll(() => pool.end());

const untouched = new Proxy(
  {},
  {
    get: (_t, name) => () => {
      throw new Error(`the engine was asked to ${String(name)}`);
    },
  },
);

describe("task runs", () => {
  it("says nothing about, and does nothing to, a run that isn't a visible task's", async () => {
    const who = await seedMember(pool);
    const taskRuns = createTaskRuns(pool, {
      port: untouched as AgentRunPort,
      runs: untouched as AgentRuns,
    });
    const caller = { workspaceId: who.workspaceId, userId: who.userId };
    await expect(taskRuns.status(caller, randomUUID())).rejects.toThrow("no such task run");
    await expect(taskRuns.cancel(caller, randomUUID())).rejects.toThrow("no such task run");
  });
});
