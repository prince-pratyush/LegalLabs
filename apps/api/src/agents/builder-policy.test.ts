import { randomUUID } from "node:crypto";
import { createGateway } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { createAdminConnectors } from "../admin-models/connectors.js";
import { createRunStack } from "../agent-runs/stack.js";
import { seedMember, testDocuments, testPool } from "../test-db.js";
import { countingProviders, denyProviders, newMatter } from "../test-model-policy.js";
import { createAgents } from "./agents.js";
import { createContextPort } from "./context.js";

const pool = testPool();
afterAll(() => pool.end());
const CLIENT = { ip: null, userAgent: null };

async function build(...deny: string[]) {
  const m = await seedMember(pool, { permissions: ["*"] });
  const me = { sessionId: randomUUID(), ...m };
  const model = countingProviders(() => "READY");
  const gateway = createGateway({ providers: model.providers, recordUsage: async () => {} });
  const documents = testDocuments(pool);
  const agents = createAgents(pool, { attachments: createContextPort(pool), documents });
  const stack = await createRunStack(pool, {
    gateway,
    documents,
    agents,
    connectors: createAdminConnectors(pool, { discovery: async () => [] }),
    env: {},
  });
  const made = await agents.create(me, { title: "Diligence", mode: "scratch" }, CLIENT);
  if (!made.ok) throw new Error(made.code);
  const matterId = await newMatter(pool, m);
  await denyProviders(pool, matterId, ...deny);
  const thread = await pool.query<{ id: string }>(
    `insert into work.thread (workspace_id, owner_id, matter_id, title)
     values ($1, $2, $3, 'Build') returning id`,
    [m.workspaceId, m.userId, matterId],
  );
  const { run_id } = await stack.agentRuns.start(me, {
    kind: "agent_builder",
    subject_id: (made as unknown as { agent: { id: string } }).agent.id,
    title: "Diligence",
    inputs: "Check the supplier's liability",
    thread_id: thread.rows[0]?.id as string,
    path: "page",
  });
  await stack.engine.result(run_id).catch(() => {});
  const { rows } = await pool.query<{ status: string; error_code: string | null }>(
    "select status, error_code from work.run where id = $1",
    [run_id],
  );
  return { calls: model.calls, run: rows[0] };
}

describe("a matter's model policy in the agent builder", () => {
  it("leaves out a denied provider", async () => {
    const { calls } = await build("anthropic");
    expect(calls.anthropic).toBe(0);
    expect(calls.ollama).toBeGreaterThan(0);
  });

  it("fails the run when no model is left", async () => {
    const { calls, run } = await build("anthropic", "ollama");
    expect(calls).toEqual({ anthropic: 0, ollama: 0 });
    expect(run).toEqual({ status: "failed", error_code: "MODEL_POLICY_NO_ELIGIBLE_MODEL" });
  });
});
