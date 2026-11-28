import { createGateway } from "@legallabs/model-gateway";
import type { RunRow } from "@legallabs/runs";
import { afterAll, describe, expect, it } from "vitest";
import { seedMember, testDocuments, testPool } from "../test-db.js";
import { countingProviders, denyProviders, fileInMatter, newMatter } from "../test-model-policy.js";
import { workflowPorts } from "./ports.js";

const pool = testPool();
afterAll(() => pool.end());

async function setup() {
  const model = countingProviders(() => "Done.");
  const gateway = createGateway({ providers: model.providers, recordUsage: async () => {} });
  const documents = testDocuments(pool);
  const ports = workflowPorts(pool, { gateway, documents });
  const m = await seedMember(pool);
  const matterId = await newMatter(pool, m);
  const uploaded = await documents.upload(
    { sessionId: "s", userId: m.userId, workspaceId: m.workspaceId },
    { name: "a.txt", bytes: new TextEncoder().encode("Rent is due."), matterId: null },
    { ip: null, userAgent: null },
  );
  if (!uploaded.ok) throw new Error(uploaded.reason);
  await documents.worker.drain(m.workspaceId);
  await fileInMatter(pool, uploaded.document.versionId, matterId);
  const file = {
    document_id: uploaded.document.id,
    version_id: uploaded.document.versionId,
    name: "a.txt",
  };
  const one = async (sql: string, params: unknown[]) =>
    (await pool.query<{ id: string }>(sql, params)).rows[0]?.id as string;
  const threadId = await one(
    "insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 'Run') returning id",
    [m.workspaceId, m.userId],
  );
  const questionId = await one(
    `insert into work.message (workspace_id, thread_id, role, content)
     values ($1, $2, 'user', 'Run') returning id`,
    [m.workspaceId, threadId],
  );
  const runId = await one(
    `insert into work.run (workspace_id, thread_id, question_id, owner_id, kind, status, subject_id)
     values ($1, $2, $3, $4, 'workflow', 'running', core.uuid7()) returning id`,
    [m.workspaceId, threadId, questionId, m.userId],
  );
  const run = {
    id: runId,
    workspace_id: m.workspaceId,
    owner_id: m.userId,
    thread_id: threadId,
    matter_id: null,
  } as RunRow;
  const complete = (documentsGiven = [file], on: RunRow = run) =>
    ports.model.complete(on, {
      routing_class: "draft",
      prompt: "What is due?",
      documents: documentsGiven,
      tables: [],
      sources: [],
      output: "text",
      deep_analysis: false,
      idempotency_key: "k",
    });
  const seal = (...providers: string[]) => denyProviders(pool, matterId, ...providers);
  return { calls: model.calls, ports, run, matterId, file, complete, seal };
}

describe("a matter's model policy in workflow model steps", () => {
  it("fails a run in a matter with no model left before any step", async () => {
    const s = await setup();
    await s.seal("anthropic", "ollama");
    const run = { ...s.run, matter_id: s.matterId } as RunRow;
    expect(await s.ports.policy.eligible(run, "draft")).toEqual([]);
    expect(await s.ports.policy.permits(run, "ollama/llama3.2:3b")).toBe(false);
  });

  it("leaves out what the matter of a step's file denies", async () => {
    const s = await setup();
    await s.seal("anthropic");
    await s.complete();
    expect(s.calls).toEqual({ anthropic: 0, ollama: 1 });
  });

  it("refuses a step whose file's matter leaves no model", async () => {
    const s = await setup();
    await s.seal("anthropic", "ollama");
    await expect(s.complete()).rejects.toMatchObject({ code: "MODEL_POLICY_NO_ELIGIBLE_MODEL" });
    expect(s.calls).toEqual({ anthropic: 0, ollama: 0 });
  });

  it("applies it to later steps that only see what was made from the file", async () => {
    const s = await setup();
    await s.seal("anthropic", "ollama");
    await pool.query(
      `insert into work.run_step (workspace_id, run_id, ordinal, kind, status, block_id, output)
       values ($1, $2, 0, 'block', 'done', 'b1', $3)`,
      [
        s.run.workspace_id,
        s.run.id,
        JSON.stringify({ read: { versions: [s.file.version_id], tables: [] } }),
      ],
    );
    await expect(s.complete([])).rejects.toMatchObject({ code: "MODEL_POLICY_NO_ELIGIBLE_MODEL" });
    expect(s.calls).toEqual({ anthropic: 0, ollama: 0 });
  });

  it("refuses a later step once a file an earlier one read is out of reach", async () => {
    const s = await setup();
    await s.seal("anthropic");
    await pool.query(
      `insert into work.run_step (workspace_id, run_id, ordinal, kind, status, block_id, output)
       values ($1, $2, 0, 'block', 'done', 'b1', $3)`,
      [
        s.run.workspace_id,
        s.run.id,
        JSON.stringify({ read: { versions: [s.file.version_id], tables: [] } }),
      ],
    );
    await pool.query(
      `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
       values ($1, $2, 'user', $3, 'deny')`,
      [s.run.workspace_id, s.matterId, s.run.owner_id],
    );
    await expect(s.complete([])).rejects.toMatchObject({ code: "MODEL_POLICY_NO_ELIGIBLE_MODEL" });
    expect(s.calls).toEqual({ anthropic: 0, ollama: 0 });
  });
});
