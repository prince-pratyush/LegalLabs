import { randomUUID } from "node:crypto";
import { createGateway, type ModelProvider } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { createAdminConnectors } from "../admin-models/connectors.js";
import { createAgents } from "../agents/agents.js";
import { createContextPort } from "../agents/context.js";
import { createSpaceModule } from "../spaces/module.js";
import { seedMember, testDocuments, testPool } from "../test-db.js";
import { createRunStack } from "./stack.js";

/*
 * The server's own wiring (`createRunStack`, as server.ts calls it) with Spaces on top. Spaces
 * has no agent catalogue of its own yet, so one is registered here.
 */

const pool = testPool();
afterAll(() => pool.end());
const CLIENT = { ip: null, userAgent: null };

async function harness(replies: string[]) {
  const admin = await seedMember(pool, { permissions: ["*"] });
  const me = { sessionId: randomUUID(), ...admin };
  const prompts: string[] = [];
  const provider: ModelProvider = {
    complete: async ({ messages }) => {
      prompts.push(messages.map((m) => m.content).join("\n"));
      return { text: replies.shift() ?? "Done.", usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
  const gateway = createGateway({ providers: { ollama: provider }, recordUsage: async () => {} });
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
  const agentId = (made as unknown as { agent: { id: string } }).agent.id;
  const spaces = stack.attach(
    createSpaceModule(pool, {
      runs: stack.taskRuns,
      catalog: {
        agent: async (_db, id) =>
          id === agentId
            ? { name: "Diligence", ownerId: admin.userId, matterId: null, full: true }
            : null,
      },
    }),
  );
  const space = await spaces.spaces.create(me, { name: "Deal", kind: "internal" }, CLIENT);
  if (!space.ok) throw new Error(space.reason);
  const spaceId = space.value.space.id;
  const shared = await spaces.spaces.addResource(
    me,
    spaceId,
    { resource_type: "agent", resource_id: agentId, access: "run" },
    CLIENT,
  );
  if (!shared.ok) throw new Error(shared.reason);
  const task = async (name: string) => {
    const t = await spaces.tasks.create(
      me,
      spaceId,
      { name, assignee: { type: "agent", agent_id: agentId } },
      CLIENT,
    );
    if (!t.ok) throw new Error(t.reason);
    return t.value;
  };
  const live = async () => {
    const saved = await agents.saveVersion(
      me,
      agentId,
      { instructions: "Review it.", attachments: [], sources: [], promote: true },
      CLIENT,
    );
    if (!saved.ok) throw new Error(saved.code);
  };
  return { admin, me, prompts, stack, spaces, spaceId, agentId, task, live };
}

const caller = (p: { userId: string; workspaceId: string }) => ({
  userId: p.userId,
  workspaceId: p.workspaceId,
});

describe("the run stack the server composes", () => {
  it("runs an agent task on the model and hands the task back when it ends", async () => {
    const h = await harness(["The supplier is sound."]);
    await h.live();
    const t = await h.task("Check the supplier");
    const runId = t.run?.id as string;
    await h.stack.engine.result(runId);
    expect(h.prompts[0]).toContain("Check the supplier");
    expect(h.prompts[0]).toContain("<space_context");
    const done = await h.spaces.tasks.get(h.me, t.id);
    expect(done?.run?.status).toBe("done");
    expect(done?.assignee).toMatchObject({ type: "user" });
    expect(await h.stack.port.get(caller(h.admin), runId)).toMatchObject({
      status: "done",
      task_id: t.id,
    });
  });

  it("refuses an agent that isn't saved, and one the caller can't reach", async () => {
    const h = await harness([]);
    const start = (who: { userId: string; workspaceId: string }) =>
      h.stack.port.start(who, { agent_id: h.agentId, path: "page" });
    await expect(start(caller(h.admin))).rejects.toMatchObject({ code: "NOT_LIVE" });
    await h.live();
    const outsider = await seedMember(pool, { permissions: ["agents.use", "threads.use"] });
    await expect(start(caller(outsider))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.prompts).toHaveLength(0);
  });

  it("takes a question's answer only from the person who started the run", async () => {
    const h = await harness([
      'ASK: {"question": "Which side are we?", "options": [], "allow_text": true}',
      "Buyer it is.",
    ]);
    await h.live();
    const t = await h.task("Check the contract");
    const runId = t.run?.id as string;
    for (let i = 0; i < 200; i += 1) {
      if ((await h.stack.port.get(caller(h.admin), runId))?.status === "awaiting_input") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await h.stack.taskRuns.status(caller(h.admin), runId)).toMatchObject({
      status: "awaiting_input",
      question: "Which side are we?",
    });
    const stranger = await seedMember(pool, { permissions: ["*"] });
    await expect(
      h.stack.taskRuns.answer(
        { workspaceId: h.admin.workspaceId, userId: stranger.userId },
        runId,
        "seller",
      ),
    ).rejects.toThrow("only the person who started the run");
    await h.stack.taskRuns.answer(caller(h.admin), runId, "buyer");
    expect(await h.stack.engine.result(runId)).toEqual({ status: "done" });
    expect(h.prompts[1]).toContain("A: buyer");
  });
});
