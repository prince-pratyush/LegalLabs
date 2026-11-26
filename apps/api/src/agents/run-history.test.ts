import { randomUUID } from "node:crypto";
import { createGateway, type ModelProvider } from "@legallabs/model-gateway";
import { createLocalEngine } from "@legallabs/runs";
import { afterAll, describe, expect, it } from "vitest";
import { runAudit } from "../agent-runs/audit.js";
import { runHandlers } from "../agent-runs/handlers.js";
import { createAgentRuns } from "../agent-runs/runs.js";
import { createRunLog } from "../runs/log.js";
import { seedMember, testDocuments, testPool } from "../test-db.js";
import { createAgents } from "./agents.js";
import { createContextPort } from "./context.js";

const pool = testPool();
afterAll(() => pool.end());

const CLIENT = { ip: null, userAgent: null };
const ANSWER = 'The fee is nine million. <c doc="D1" page="1" quote="fee is nine million"/>';

/** A run on a matter, by an agent a colleague holds Full access on. */
async function sharedAgentRun() {
  const owner = await seedMember(pool, { permissions: ["*"] });
  const me = { sessionId: randomUUID(), ...owner };
  const colleagueId = (
    await pool.query<{ id: string }>(
      `insert into core."user" (workspace_id, email, role_id, status)
       select workspace_id, 'col@' || id || '.test', role_id, 'active' from core."user"
        where id = $1 returning id`,
      [owner.userId],
    )
  ).rows[0]?.id as string;
  const colleague = {
    sessionId: randomUUID(),
    workspaceId: owner.workspaceId,
    userId: colleagueId,
  };
  const matterId = (
    await pool.query<{ id: string }>(
      `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name)
       values ($1, 'C1', 'Client', '1', 'Matter') returning id`,
      [owner.workspaceId],
    )
  ).rows[0]?.id as string;

  const provider: ModelProvider = {
    complete: async () => ({ text: ANSWER, usage: { input_tokens: 10, output_tokens: 5 } }),
  };
  const gateway = createGateway({ providers: { ollama: provider }, recordUsage: async () => {} });
  const documents = testDocuments(pool);
  const agents = createAgents(pool, { attachments: createContextPort(pool), documents });
  const engine = createLocalEngine({
    pool,
    handlers: runHandlers(pool, { gateway, agents }),
    audit: runAudit(pool),
  });
  const runs = createAgentRuns(pool, { engine });

  const doc = await documents.upload(
    me,
    { name: "fees.txt", bytes: new TextEncoder().encode("The fee is nine million."), matterId },
    CLIENT,
  );
  if (!doc.ok) throw new Error(doc.reason);
  const made = await agents.create(me, { title: "Fees", mode: "scratch" }, CLIENT);
  if (!made.ok) throw new Error(made.code);
  const agentId = (made as unknown as { agent: { id: string } }).agent.id;
  const saved = await agents.saveVersion(
    me,
    agentId,
    {
      instructions: "Report the fee.",
      attachments: [{ label: "fees", kind: "upload", ref: doc.document.id, name: "fees.txt" }],
      sources: [],
      promote: true,
    },
    CLIENT,
  );
  if (!saved.ok) throw new Error(saved.code);
  const shared = await agents.share(
    me,
    agentId,
    { principal_type: "user", principal_id: colleagueId, level: "full" },
    CLIENT,
  );
  expect(shared.ok).toBe(true);
  const version = (await agents.get(me, agentId))?.agent.live_version_id as string;
  const { run_id } = await runs.start(me, {
    kind: "agent",
    subject_id: agentId,
    agent_version_id: version,
    title: "Fees",
    path: "page",
    matter_id: matterId,
  });
  expect(await engine.result(run_id)).toEqual({ status: "done" });

  const wall = () =>
    pool.query(
      `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
       values ($1, $2, 'user', $3, 'deny')`,
      [owner.workspaceId, matterId, colleagueId],
    );
  return { me, colleague, runs, log: createRunLog(pool), run_id, wall };
}

describe("what a Full-access holder sees of someone else's run", () => {
  it("is its progress, never the answer, the quotes or the questions", async () => {
    const h = await sharedAgentRun();
    const mine = await h.log.replay(h.me, h.run_id, 0);
    expect(JSON.stringify(mine)).toContain("nine million");

    expect(await h.runs.get(h.colleague, h.run_id)).toMatchObject({ status: "done" });
    const theirs = await h.log.replay(h.colleague, h.run_id, 0);
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.map((e) => e.type)).not.toContain("token");
    expect(theirs.map((e) => e.type)).not.toContain("citation");
    expect(JSON.stringify(theirs)).not.toContain("nine million");
    expect(JSON.stringify(await h.runs.steps(h.colleague, h.run_id))).not.toContain("nine million");
  });

  it("is nothing at all once they are walled from the run's matter", async () => {
    const h = await sharedAgentRun();
    await h.wall();
    expect(await h.runs.get(h.colleague, h.run_id)).toBeNull();
    expect(await h.runs.list(h.colleague)).toEqual([]);
    expect(await h.runs.steps(h.colleague, h.run_id)).toBeNull();
    expect(await h.log.replay(h.colleague, h.run_id, 0)).toEqual([]);
    expect(await h.runs.get(h.me, h.run_id)).toMatchObject({ status: "done" });
  });
});
