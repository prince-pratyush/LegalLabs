import type { AuthorityPassage, KnowledgePort, RunEvent, VaultPort } from "@legallabs/contracts";
import type { Message, ModelProvider } from "@legallabs/model-gateway";
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
import { type AskResult, NOT_FOUND_ANSWER } from "./threads.js";

const pool = testPool();
afterAll(() => pool.end());

const client = { ip: "203.0.113.9", userAgent: "vitest" };
const CLAUSE = "The supplier accepts liability for direct loss up to the fees paid.";
const asPrincipal = (m: Seeded): Principal => ({
  sessionId: "00000000-0000-7000-8000-000000000000",
  userId: m.userId,
  workspaceId: m.workspaceId,
});

// A stand-in model that streams its answer a few characters at a time.
function fakeModel(answer: string) {
  const calls: (readonly Message[])[] = [];
  const provider: ModelProvider = {
    complete: async ({ messages }) => {
      calls.push(messages);
      return { text: answer, usage: { input_tokens: 1200, output_tokens: 80 } };
    },
    stream: async ({ messages }, onText) => {
      calls.push(messages);
      for (let i = 0; i < answer.length; i += 5) onText(answer.slice(i, i + 5));
      return { text: answer, usage: { input_tokens: 1200, output_tokens: 80 } };
    },
  };
  return { provider, calls };
}

const failing: ModelProvider = {
  complete: async () => {
    throw new Error("provider down");
  },
};

const cited = (quote: string, doc = "D1", page = 1) =>
  `<c doc="${doc}" page="${page}" quote="${quote}"/>`;

async function upload(m: Seeded, text = CLAUSE, name = "msa.txt", matterId: string | null = null) {
  const result = await testDocuments(pool).upload(
    asPrincipal(m),
    { name, bytes: new TextEncoder().encode(text), matterId },
    client,
  );
  if (!result.ok) throw new Error(result.reason);
  return result.document;
}

function harness(
  provider: ModelProvider,
  extra: { vaults?: VaultPort; knowledge?: KnowledgePort; local?: boolean } = {},
) {
  return testThreads(
    pool,
    testDocuments(pool),
    extra.local ? { ollama: provider } : { anthropic: provider },
    extra.vaults,
    extra.knowledge,
  );
}

async function done(result: AskResult) {
  if (!result.ok) throw new Error(`expected a run, got ${result.reason}`);
  await result.finished;
  return result;
}

const ask = (question: string, documentIds: string[], extra: object = {}) => ({
  blocks: [{ type: "text" as const, text: question }],
  scope: { document_ids: documentIds, vault_ids: [], sources: [] },
  ...extra,
});

describe("asking a question", () => {
  it("streams the answer, verifies each citation before announcing it, and stores both", async () => {
    const m = await seedMember(pool);
    const document = await upload(m);
    const quote = "accepts liability for direct loss";
    const { threads, log } = harness(fakeModel(`The supplier is liable.${cited(quote)}`).provider);
    const principal = asPrincipal(m);

    const run = await done(
      await threads.ask(principal, ask("Who is liable?", [document.id]), client),
    );

    const events = await log.replay(principal, run.runId, 0);
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("status");
    expect(types.at(-1)).toBe("done");
    expect(types.indexOf("citation")).toBeLessThan(types.indexOf("done"));
    expect(events.map((event) => event.seq)).toEqual(events.map((_, i) => i + 1));
    const streamed = events
      .flatMap((event) => (event.type === "token" ? [event.delta] : []))
      .join("");
    expect(streamed).toBe("The supplier is liable.[[c:1]]");
    const citation = events.find((event) => event.type === "citation");
    expect(citation).toMatchObject({
      citation: {
        ordinal: 1,
        verified: "ok",
        quote,
        open_url: `/d/${document.id}/v/1?p=1&cf=${CLAUSE.indexOf(quote)}&ct=${CLAUSE.indexOf(quote) + quote.length}`,
      },
    });
    const coverage = events.find((event) => event.type === "coverage");
    expect(coverage).toMatchObject({
      coverage: { mode: "full_read", docs_read: 1, pages_read: 1 },
    });

    const view = await threads.get(principal, run.threadId);
    const answer = view?.messages.at(-1);
    expect(view?.title).toBe("Who is liable?");
    expect(answer).toMatchObject({
      role: "assistant",
      content: "The supplier is liable.",
      model: "anthropic/claude-haiku-5-5",
      inputTokens: 1200,
      outputTokens: 80,
      ungrounded: [],
    });
    expect(answer?.citations).toEqual([
      expect.objectContaining({ n: 1, status: "ok", versionNo: 1, documentName: "msa.txt", quote }),
    ]);
    const final = events.at(-1) as Extract<RunEvent, { type: "done" }>;
    expect(final.message_id).toBe(answer?.id);
    expect(final.citations).toEqual({
      total: 1,
      ok: 1,
      mismatch: 0,
      unresolved: 0,
      ungrounded_sentences: 0,
    });
    expect((await threads.run(principal, run.runId))?.status).toBe("done");
  });

  it("flags a claim with no verified source instead of letting it pass silently", async () => {
    const m = await seedMember(pool);
    const document = await upload(m);
    const { threads } = harness(
      fakeModel(
        `The supplier is liable.${cited("accepts liability")} The cap is ten million dollars. Fees are due in thirty days.${cited("not on the page at all")}`,
      ).provider,
    );
    const principal = asPrincipal(m);

    const run = await done(await threads.ask(principal, ask("Tell me", [document.id]), client));

    const answer = (await threads.get(principal, run.threadId))?.messages.at(-1);
    const flagged = (answer?.ungrounded ?? []).map(([from, to]) => answer?.content.slice(from, to));
    expect(flagged).toEqual(["The cap is ten million dollars.", "Fees are due in thirty days."]);
    expect(answer?.citations.map((c) => c.status)).toEqual(["ok", "mismatch"]);
  });

  it("reads by retrieval when the files don't fit the model's window, and says how much it read", async () => {
    const m = await seedMember(pool);
    const filler = "Unrelated boilerplate about deliveries and packaging. ".repeat(400);
    const document = await upload(m, `${filler}\n${CLAUSE}`);
    const { threads, log } = harness(fakeModel(`Liable.${cited("accepts liability")}`).provider, {
      local: true,
    });
    const principal = asPrincipal(m);

    const run = await done(
      await threads.ask(principal, ask("Who accepts liability?", [document.id]), client),
    );

    const coverage = (await log.replay(principal, run.runId, 0)).find((e) => e.type === "coverage");
    expect(coverage).toMatchObject({ coverage: { mode: "retrieval", docs_in_scope: 1 } });
  });

  it("says it wasn't found, without a model, when the scope has no readable text", async () => {
    const m = await seedMember(pool);
    const model = fakeModel("never used");
    const { threads, knowledge } = harness(model.provider, {
      knowledge: { list: async () => [], search: async () => [] },
    });
    const principal = asPrincipal(m);
    const run = await done(
      await threads.ask(
        principal,
        {
          blocks: [{ type: "text", text: "Any case law?" }],
          scope: { document_ids: [], vault_ids: [], sources: [{ source_id: "us-case-law" }] },
        },
        client,
      ),
    );
    expect(knowledge).toBeDefined();
    expect(model.calls).toHaveLength(0);
    expect((await threads.get(principal, run.threadId))?.messages.at(-1)?.content).toBe(
      NOT_FOUND_ANSWER,
    );
  });

  it("refuses an empty scope, a model the install can't use, and mixed matters", async () => {
    const m = await seedMember(pool);
    const principal = asPrincipal(m);
    const { threads } = harness(fakeModel("x").provider);
    expect(await threads.ask(principal, ask("Q", []), client)).toEqual({
      ok: false,
      reason: "EMPTY_SCOPE",
    });
    const document = await upload(m);
    expect(
      await threads.ask(
        principal,
        ask("Q", [document.id], { model: "google/gemini-3.6-flash" }),
        client,
      ),
    ).toEqual({ ok: false, reason: "MODEL_NOT_ALLOWED" });
    const { rows } = await pool.query<{ id: string }>(
      `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name, wall_mode)
       values ($1, 'C1', 'Client', 'M-1', 'M', 'open') returning id`,
      [m.workspaceId],
    );
    const inMatter = await upload(m, CLAUSE, "b.txt", rows[0]?.id ?? null);
    expect(await threads.ask(principal, ask("Q", [document.id, inMatter.id]), client)).toEqual({
      ok: false,
      reason: "MIXED_MATTERS",
    });
  });

  it("fails the run, stores no answer, and says so when every model fails", async () => {
    const m = await seedMember(pool);
    const document = await upload(m);
    const { threads, log } = harness(failing);
    const principal = asPrincipal(m);

    const run = await done(await threads.ask(principal, ask("Q?", [document.id]), client));

    const trail = await log.replay(principal, run.runId, 0);
    expect(trail.slice(-2)).toMatchObject([
      { type: "error", code: "MODEL_UNAVAILABLE", retryable: true },
      { type: "status", status: "failed" },
    ]);
    expect((await threads.run(principal, run.runId))?.status).toBe("failed");
    expect((await threads.get(principal, run.threadId))?.messages.map((x) => x.role)).toEqual([
      "user",
    ]);
  });

  it("keeps earlier turns in a follow-up, and audits ids and counts but never text", async () => {
    const m = await seedMember(pool);
    const document = await upload(m);
    const model = fakeModel(`Liable.${cited("accepts liability")}`);
    const { threads } = harness(model.provider);
    const principal = asPrincipal(m);
    const first = await done(
      await threads.ask(principal, ask("Secret first question?", [document.id]), client),
    );

    await done(
      await threads.ask(
        principal,
        { ...ask("And the cap?", []), threadId: first.threadId },
        client,
      ),
    );

    const followUp = model.calls[1] ?? [];
    expect(followUp.map((x) => x.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(followUp.at(-1)?.content).toContain(CLAUSE);
    const trail = JSON.stringify(await auditTrail(pool, m.workspaceId));
    expect(trail).toContain("model.call");
    expect(trail).not.toContain("Secret first question");
    expect(trail).not.toContain("Liable");
  });

  it("verifies a public-law citation against the passage it was shown", async () => {
    const m = await seedMember(pool);
    const passage: AuthorityPassage = {
      authority_id: "cl:1",
      source_id: "us-case-law",
      citation_string: "Doe v. Roe, 1 F.4th 2",
      title: "Doe v. Roe",
      url: "https://example.test/doe",
      text: "The motion to dismiss is denied because the claim is timely.",
    };
    const { threads } = harness(
      fakeModel(`Denied.<c auth="A1" quote="The motion to dismiss is denied"/>`).provider,
      { knowledge: { list: async () => [], search: async () => [passage] } },
    );
    const principal = asPrincipal(m);
    const run = await done(
      await threads.ask(
        principal,
        {
          blocks: [{ type: "text", text: "Was it dismissed?" }],
          scope: { document_ids: [], vault_ids: [], sources: [{ source_id: "us-case-law" }] },
        },
        client,
      ),
    );
    const citation = (await threads.get(principal, run.threadId))?.messages.at(-1)?.citations[0];
    expect(citation).toMatchObject({
      kind: "authority",
      status: "ok",
      authority: { id: "cl:1", citation: "Doe v. Roe, 1 F.4th 2", url: "https://example.test/doe" },
    });
  });

  it("reads files from a vault and keeps the cited ones on the thread", async () => {
    const m = await seedMember(pool);
    const inVault = await upload(m, CLAUSE, "vault-file.txt");
    const vaults: VaultPort = {
      list: async () => [
        { id: "00000000-0000-7000-8000-00000000000a", name: "Deal room", file_count: 1 },
      ],
      documentIds: async () => [inVault.id],
    };
    const { threads } = harness(fakeModel(`Liable.${cited("accepts liability")}`).provider, {
      vaults,
    });
    const principal = asPrincipal(m);
    const run = await done(
      await threads.ask(
        principal,
        {
          blocks: [{ type: "text", text: "Who is liable?" }],
          scope: {
            document_ids: [],
            vault_ids: ["00000000-0000-7000-8000-00000000000a"],
            sources: [],
          },
        },
        client,
      ),
    );
    const view = await threads.get(principal, run.threadId);
    expect(view?.vaultIds).toEqual(["00000000-0000-7000-8000-00000000000a"]);
    expect(view?.documents.map((d) => d.name)).toEqual(["vault-file.txt"]);
    expect(view?.messages.at(-1)?.citations[0]?.status).toBe("ok");
  });

  it("stops a run on cancel and saves nothing more", async () => {
    const m = await seedMember(pool);
    const document = await upload(m);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: ModelProvider = {
      complete: async () => ({ text: "x" }),
      stream: async (_request, onText) => {
        onText("Partial ");
        await gate;
        onText("rest.");
        return { text: "Partial rest." };
      },
    };
    const { threads, log } = harness(slow);
    const principal = asPrincipal(m);
    const run = await threads.ask(principal, ask("Q?", [document.id]), client);
    if (!run.ok) throw new Error(run.reason);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await threads.cancel(principal, run.runId, client)).toBe(true);
    release();
    await run.finished;

    expect((await threads.run(principal, run.runId))?.status).toBe("cancelled");
    expect((await log.replay(principal, run.runId, 0)).some((e) => e.type === "done")).toBe(false);
    expect(await threads.cancel(principal, run.runId, client)).toBe(false);
  });
});

describe("sharing", () => {
  it("lets a colleague read but not continue, and duplicate into their own thread", async () => {
    const owner = await seedMember(pool);
    const document = await upload(owner);
    const { rows } = await pool.query<{ id: string }>(
      `insert into core."user" (workspace_id, email, role_id, status)
       select workspace_id, 'ben@' || $2, role_id, 'active' from core."user" where id = $1 returning id`,
      [owner.userId, owner.slug],
    );
    const colleague = { ...owner, userId: rows[0]?.id ?? "" };
    const { threads } = harness(fakeModel(`Liable.${cited("accepts liability")}`).provider);
    const run = await done(
      await threads.ask(asPrincipal(owner), ask("Who?", [document.id]), client),
    );

    expect(await threads.get(asPrincipal(colleague), run.threadId)).toBeNull();
    const shared = await threads.share(
      asPrincipal(owner),
      run.threadId,
      { userIds: [colleague.userId], link: false },
      client,
    );
    expect(shared).toEqual({
      ok: true,
      outcomes: [{ userId: colleague.userId, outcome: "created" }],
    });

    const seen = await threads.get(asPrincipal(colleague), run.threadId);
    expect(seen?.mine).toBe(false);
    expect(seen?.messages).toHaveLength(2);
    expect(
      await threads.ask(
        asPrincipal(colleague),
        { ...ask("More?", []), threadId: run.threadId },
        client,
      ),
    ).toEqual({ ok: false, reason: "READ_ONLY" });
    // The owner's file is private to them, so the copy can't take it along.
    const copy = await threads.duplicate(asPrincipal(colleague), run.threadId, client);
    const duplicated = await threads.get(asPrincipal(colleague), copy ?? "");
    expect(duplicated?.mine).toBe(true);
    expect(duplicated?.documents).toEqual([]);

    const [grant] = (await threads.shares(asPrincipal(owner), run.threadId)) ?? [];
    expect(await threads.revoke(asPrincipal(owner), run.threadId, grant?.id ?? "", client)).toBe(
      true,
    );
    expect(await threads.get(asPrincipal(colleague), run.threadId)).toBeNull();
  });
});

describe("history", () => {
  it("searches titles and the caller's own prompts, and filters favourites", async () => {
    const m = await seedMember(pool);
    const document = await upload(m);
    const { threads } = harness(fakeModel(`Liable.${cited("accepts liability")}`).provider);
    const principal = asPrincipal(m);
    const first = await done(
      await threads.ask(principal, ask("Indemnity question", [document.id]), client),
    );
    await done(
      await threads.ask(
        principal,
        { ...ask("What about the 100% cap_limit?", []), threadId: first.threadId },
        client,
      ),
    );
    const second = await done(
      await threads.ask(principal, ask("Notice period", [document.id]), client),
    );

    const titles = async (filters: object) =>
      (await threads.history(principal, filters)).rows.map((row) => row.title);
    expect(await titles({})).toEqual(["Notice period", "Indemnity question"]);
    expect(await titles({ q: "cap_limit" })).toEqual(["Indemnity question"]);
    expect(await titles({ q: "%" })).toEqual(["Indemnity question"]);
    expect(await titles({ docs: "1" })).toHaveLength(2);
    expect(await titles({ docs: "0" })).toEqual([]);

    expect(await threads.favourite(principal, second.threadId, true)).toBe(true);
    expect(await titles({ favourites: true })).toEqual(["Notice period"]);
    const [row] = (await threads.history(principal, { favourites: true })).rows;
    expect(row).toMatchObject({
      type: "assist",
      status: "done",
      documentCount: 1,
      favourite: true,
      shared: false,
    });
  });
});
