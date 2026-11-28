import { randomUUID } from "node:crypto";
import { createGateway, type ModelProvider } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { createAdminConnectors } from "../admin-models/connectors.js";
import { createRunStack } from "../agent-runs/stack.js";
import { seedMember, testDocuments, testPool } from "../test-db.js";
import { denyProviders, fileInMatter, newMatter } from "../test-model-policy.js";
import { createAgents } from "./agents.js";
import { createContextPort } from "./context.js";

const pool = testPool();
afterAll(() => pool.end());
const CLIENT = { ip: null, userAgent: null };

// An agent run outside any matter, with a matter's file attached.
async function setup(replies: string[] = []) {
  const m = await seedMember(pool, { permissions: ["*"] });
  const me = { sessionId: randomUUID(), ...m };
  const calls = { anthropic: 0, ollama: 0 };
  const provider = (name: keyof typeof calls): ModelProvider => ({
    complete: async () => {
      calls[name]++;
      return { text: replies.shift() ?? "Done.", usage: { input_tokens: 10, output_tokens: 5 } };
    },
  });
  const gateway = createGateway({
    providers: { anthropic: provider("anthropic"), ollama: provider("ollama") },
    recordUsage: async () => {},
  });
  const documents = testDocuments(pool);
  const agents = createAgents(pool, { attachments: createContextPort(pool), documents });
  const stack = await createRunStack(pool, {
    gateway,
    documents,
    agents,
    connectors: createAdminConnectors(pool, { discovery: async () => [] }),
    env: {},
  });
  const uploaded = await documents.upload(
    me,
    { name: "a.txt", bytes: new TextEncoder().encode("Rent is due."), matterId: null },
    CLIENT,
  );
  if (!uploaded.ok) throw new Error(uploaded.reason);
  await documents.worker.drain(m.workspaceId);
  const matterId = await newMatter(pool, m);
  await fileInMatter(pool, uploaded.document.versionId, matterId);
  const made = await agents.create(me, { title: "Rent", mode: "scratch" }, CLIENT);
  if (!made.ok) throw new Error(made.code);
  const agentId = (made as unknown as { agent: { id: string } }).agent.id;
  const saved = await agents.saveVersion(
    me,
    agentId,
    {
      instructions: "Read @lease.",
      attachments: [{ label: "lease", kind: "upload", ref: uploaded.document.id, name: "a.txt" }],
      sources: [],
      promote: true,
    },
    CLIENT,
  );
  if (!saved.ok) throw new Error(saved.code);
  const who = { userId: m.userId, workspaceId: m.workspaceId };
  const start = async () =>
    (await stack.port.start(who, { agent_id: agentId, path: "page" })).run_id;
  const run = async (id: string) =>
    (
      await pool.query<{ status: string; error_code: string | null }>(
        "select status, error_code from work.run where id = $1",
        [id],
      )
    ).rows[0];
  const seal = (...providers: string[]) => denyProviders(pool, matterId, ...providers);
  const wall = () =>
    pool.query(
      `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
       values ($1, $2, 'user', $3, 'deny')`,
      [m.workspaceId, matterId, m.userId],
    );
  return { calls, stack, who, start, run, seal, wall };
}

describe("a matter's model policy in an agent run outside the matter", () => {
  it("leaves out what the matter of an attached file denies", async () => {
    const s = await setup();
    await s.seal("anthropic");
    await s.stack.engine.result(await s.start());
    expect(s.calls).toEqual({ anthropic: 0, ollama: 1 });
  });

  it("fails the run when the file's matter leaves no model", async () => {
    const s = await setup();
    await s.seal("anthropic", "ollama");
    const id = await s.start();
    await s.stack.engine.result(id).catch(() => {});
    expect(s.calls).toEqual({ anthropic: 0, ollama: 0 });
    expect(await s.run(id)).toEqual({
      status: "failed",
      error_code: "MODEL_POLICY_NO_ELIGIBLE_MODEL",
    });
  });

  it("holds a later step to what an earlier one read", async () => {
    const s = await setup(['ASK: {"question": "Which side?", "allow_text": true}']);
    const id = await s.start();
    for (let i = 0; i < 200; i += 1) {
      if ((await s.stack.port.get(s.who, id))?.status === "awaiting_input") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const before = { ...s.calls };
    // Walled now: the next step is not shown the file, but what was made from it stays.
    await s.wall();
    await s.stack.taskRuns.answer(s.who, id, "tenant");
    await s.stack.engine.result(id).catch(() => {});
    expect(s.calls).toEqual(before);
    expect((await s.run(id))?.error_code).toBe("MODEL_POLICY_NO_ELIGIBLE_MODEL");
  });
});
