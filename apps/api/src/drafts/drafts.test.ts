import type { Message, ModelProvider } from "@legallabs/model-gateway";
import { createGateway } from "@legallabs/model-gateway";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import type { Principal } from "../auth/auth.js";
import {
  auditTrail,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { createDrafts } from "./drafts.js";

const pool = testPool();
afterAll(() => pool.end());

const client = { ip: "203.0.113.9", userAgent: "vitest" };
const CLAUSE = "The supplier accepts liability for direct loss up to the fees paid.";
const asPrincipal = (m: Seeded): Principal => ({
  sessionId: "00000000-0000-7000-8000-000000000000",
  userId: m.userId,
  workspaceId: m.workspaceId,
});

function model(reply: (messages: readonly Message[]) => string): ModelProvider {
  return {
    complete: async ({ messages }) => ({
      text: reply(messages),
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
  };
}

async function threadWithAnswer(m: Seeded) {
  const principal = asPrincipal(m);
  const documents = testDocuments(pool);
  const uploaded = await documents.upload(
    principal,
    { name: "msa.txt", bytes: new TextEncoder().encode(CLAUSE), matterId: null },
    client,
  );
  if (!uploaded.ok) throw new Error(uploaded.reason);
  const { threads } = testThreads(pool, documents, {
    anthropic: model(
      () =>
        'The supplier is liable.<c doc="D1" page="1" quote="accepts liability"/> Not checked.<c doc="D1" page="1" quote="nowhere on the page"/>',
    ),
  });
  const run = await threads.ask(
    principal,
    {
      blocks: [{ type: "text", text: "Who is liable?" }],
      scope: { document_ids: [uploaded.document.id], vault_ids: [], sources: [] },
    },
    client,
  );
  if (!run.ok) throw new Error(run.reason);
  await run.finished;
  const view = await threads.get(principal, run.threadId);
  return { principal, threadId: run.threadId, answerId: view?.messages.at(-1)?.id ?? "" };
}

const drafting = (reply: (messages: readonly Message[]) => string = () => "x") =>
  createDrafts(pool, {
    gateway: createGateway({ providers: { anthropic: model(reply) }, recordUsage: async () => {} }),
  });

describe("drafts", () => {
  it("starts from an answer with its citations kept, flagged ones marked", async () => {
    const m = await seedMember(pool);
    const { principal, threadId, answerId } = await threadWithAnswer(m);

    const created = await drafting().create(
      principal,
      threadId,
      { kind: "editor", fromMessageId: answerId },
      client,
    );

    if (!created.ok) throw new Error(created.reason);
    expect(created.draft.latest.body).toBe(
      'The supplier is liable. [1] Not checked. [2]\n\n## Sources\n\n1. msa.txt, p. 1: "accepts liability"\n2. msa.txt, p. 1: "nowhere on the page" (not verified)',
    );
    expect(created.draft.versions).toMatchObject([{ no: 1, author: "assistant" }]);
    expect(JSON.stringify(await auditTrail(pool, m.workspaceId))).toContain("draft.created");
  });

  it("keeps every version: the assistant's edit, a user edit and a restore", async () => {
    const m = await seedMember(pool);
    const { principal, threadId } = await threadWithAnswer(m);
    let sent = "";
    const drafts = drafting((messages) => {
      sent = messages.at(-1)?.content ?? "";
      return "```markdown\n# Memo\n\nThe cap is twelve months of fees.\n```";
    });
    const created = await drafts.create(
      principal,
      threadId,
      { kind: "editor", title: "Memo" },
      client,
    );
    if (!created.ok) throw new Error(created.reason);
    const id = created.draft.id;

    const saved = await drafts.save(principal, id, "# Memo\n\nThe cap is six months of fees.");
    const edited = await drafts.edit(principal, id, "Make the cap twelve months.");
    if (!edited.ok) throw new Error(edited.reason);
    expect(sent).toContain("The cap is six months of fees.");
    expect(sent).toContain("Instruction: Make the cap twelve months.");
    expect(edited.draft.latest).toEqual({
      no: 3,
      body: "# Memo\n\nThe cap is twelve months of fees.",
    });
    expect(saved.ok && saved.draft.versions.at(-1)?.author).toBe("user");
    expect(edited.draft.versions.at(-1)).toMatchObject({
      author: "assistant",
      changes: { insertions: 1, deletions: 1 },
    });

    const diff = await drafts.diff(principal, id, 2, 3);
    expect(diff?.ops.filter((op) => op.op !== "equal")).toEqual([
      { op: "delete", text: "six" },
      { op: "insert", text: "twelve" },
    ]);

    const restored = await drafts.restore(principal, id, 2);
    if (!restored.ok) throw new Error(restored.reason);
    expect(restored.draft.latest).toEqual({
      no: 4,
      body: "# Memo\n\nThe cap is six months of fees.",
    });
    expect(await drafts.body(principal, id, 3)).toBe("# Memo\n\nThe cap is twelve months of fees.");
  });

  it("exports Word with the changes since a version as tracked changes", async () => {
    const m = await seedMember(pool);
    const { principal, threadId } = await threadWithAnswer(m);
    const drafts = drafting();
    const created = await drafts.create(
      principal,
      threadId,
      { kind: "editor", title: "Memo / v2" },
      client,
    );
    if (!created.ok) throw new Error(created.reason);
    await drafts.save(principal, created.draft.id, "The cap is six months.");
    await drafts.save(principal, created.draft.id, "The cap is twelve months.");

    const file = await drafts.export(principal, created.draft.id, { trackedFrom: 2 }, client);

    expect(file?.filename).toBe("Memo v2.docx");
    const parts = unzipSync(file?.bytes ?? new Uint8Array());
    const document = strFromU8(parts["word/document.xml"] ?? new Uint8Array());
    expect(document).toContain("<w:ins ");
    expect(document).toContain("<w:delText");
    expect(document).toContain("twelve");
    expect(JSON.stringify(await auditTrail(pool, m.workspaceId))).toContain("draft.exported");
  });

  it("lets only the thread's owner create or change drafts", async () => {
    const m = await seedMember(pool);
    const other = await seedMember(pool);
    const { principal, threadId } = await threadWithAnswer(m);
    const drafts = drafting();
    const created = await drafts.create(principal, threadId, { kind: "notepad" }, client);
    if (!created.ok) throw new Error(created.reason);

    expect(await drafts.create(asPrincipal(other), threadId, { kind: "notepad" }, client)).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
    expect(await drafts.save(asPrincipal(other), created.draft.id, "mine now")).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
    expect(await drafts.get(asPrincipal(other), created.draft.id)).toBeNull();
    expect(await drafts.export(asPrincipal(other), created.draft.id, {}, client)).toBeNull();
  });
});
