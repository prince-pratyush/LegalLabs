import { createGateway, type ModelProvider } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { createDocuments } from "../documents/documents.js";
import { PASSWORD, type Seeded, seedMember, testPool } from "../test-db.js";
import { createThreads } from "./threads.js";

const pool = testPool();
afterAll(() => pool.end());

const CLAUSE = "The supplier accepts liability for direct loss.";
const ANSWER = 'Yes<c doc="D1" page="1" quote="accepts liability for direct loss"/>.';

const answering = (text: string): ModelProvider => ({
  complete: async () => ({ text, usage: { input_tokens: 100, output_tokens: 10 } }),
});

function harness(provider: ModelProvider = answering(ANSWER)) {
  const documents = createDocuments(pool);
  const gateway = createGateway({
    providers: { anthropic: provider },
    recordUsage: async () => {},
  });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: createThreads(pool, { gateway, documents }),
    clientIp: () => "203.0.113.9",
  });
  const signIn = async (m: Seeded) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const post = (cookie: string, path: string, body: unknown) =>
    app.request(`/api/v1/threads${path}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const get = (cookie: string, path: string) =>
    app.request(`/api/v1/threads${path}`, { headers: { cookie } });
  const upload = async (cookie: string, content = CLAUSE, matterId?: string) => {
    const form = new FormData();
    form.set("file", new File([content], "msa.txt"));
    if (matterId) form.set("matter_id", matterId);
    const res = await app.request("/api/v1/documents", {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    return ((await res.json()) as { document: { id: string; version_id: string } }).document;
  };
  return { signIn, post, get, upload };
}

async function ready(provider?: ModelProvider) {
  const m = await seedMember(pool);
  const h = harness(provider);
  const cookie = await h.signIn(m);
  return { m, h, cookie, document: await h.upload(cookie) };
}

describe("threads API", () => {
  it("needs a session for every route", async () => {
    const h = harness();
    const id = "00000000-0000-7000-8000-000000000000";
    for (const res of [
      await h.post("", "", { question: "q", document_ids: [id] }),
      await h.get("", ""),
      await h.get("", `/${id}`),
      await h.post("", `/${id}/messages`, { question: "q" }),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "UNAUTHENTICATED" });
    }
  });

  it("asks, follows up, lists and reads a thread", async () => {
    const { h, cookie, document } = await ready();
    const created = await h.post(cookie, "", {
      question: "Who accepts liability?",
      document_ids: [document.id],
    });
    expect(created.status).toBe(201);
    const { thread } = (await created.json()) as { thread: Record<string, unknown> };
    expect(thread).toMatchObject({
      title: "Who accepts liability?",
      matter_id: null,
      documents: [
        {
          id: document.id,
          version_id: document.version_id,
          name: "msa.txt",
          page_count: 1,
          empty_page_count: 0,
        },
      ],
    });
    const [question, answer] = thread.messages as Record<string, unknown>[];
    expect(question).toMatchObject({
      role: "user",
      content: "Who accepts liability?",
      citations: [],
    });
    expect(answer).toMatchObject({
      role: "assistant",
      content: "Yes.",
      model: "anthropic/claude-haiku-5-5",
      citations: [
        {
          n: 1,
          at: 3,
          document_id: document.id,
          version_id: document.version_id,
          document_name: "msa.txt",
          page: 1,
          quote: "accepts liability for direct loss",
          char_from: CLAUSE.indexOf("accepts"),
          char_to: CLAUSE.length - 1,
          status: "ok",
        },
      ],
    });

    const followed = await h.post(cookie, `/${thread.id}/messages`, { question: "And loss?" });
    expect(followed.status).toBe(200);
    const after = (await followed.json()) as { thread: { messages: unknown[] } };
    expect(after.thread.messages).toHaveLength(4);

    const listed = await h.get(cookie, "");
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(await listed.json()).toEqual({
      threads: [
        {
          id: thread.id,
          title: "Who accepts liability?",
          matter_id: null,
          created_at: thread.created_at,
        },
      ],
    });
    expect(await (await h.get(cookie, `/${thread.id}`)).json()).toEqual(after);
  });

  it("rejects a malformed request without asking", async () => {
    const { h, cookie, document } = await ready();
    for (const body of [
      "not json",
      {},
      { question: "", document_ids: [document.id] },
      { question: "q", document_ids: [] },
      { question: "q", document_ids: ["not-a-uuid"] },
      { question: "a\0b", document_ids: [document.id] },
      { question: "x".repeat(2001), document_ids: [document.id] },
    ]) {
      const res = await h.post(cookie, "", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
  });

  it("says when a thread or document isn't there", async () => {
    const { h, cookie } = await ready();
    const other = await seedMember(pool);
    const theirs = await h.upload(await h.signIn(other));
    const missing = await h.post(cookie, "", { question: "q", document_ids: [theirs.id] });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "NOT_FOUND" });
    for (const path of ["/not-a-uuid", "/00000000-0000-7000-8000-000000000000"]) {
      expect((await h.get(cookie, path)).status).toBe(404);
      expect((await h.post(cookie, `${path}/messages`, { question: "q" })).status).toBe(404);
    }
  });

  it("refuses documents from different matters", async () => {
    const { m, h, cookie, document } = await ready();
    const { rows } = await pool.query<{ id: string }>(
      `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name, wall_mode)
       values ($1, 'C1', 'Client', 'M1', 'M1', 'open') returning id`,
      [m.workspaceId],
    );
    const inMatter = await h.upload(cookie, CLAUSE, rows[0]?.id);
    const res = await h.post(cookie, "", {
      question: "liability",
      document_ids: [document.id, inMatter.id],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "MIXED_MATTERS" });
  });

  it("says the model is unavailable and saves nothing", async () => {
    const failing: ModelProvider = {
      complete: async () => {
        throw new Error("down");
      },
    };
    const { h, cookie, document } = await ready(failing);
    const res = await h.post(cookie, "", { question: "liability", document_ids: [document.id] });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "MODEL_UNAVAILABLE" });
    expect(await (await h.get(cookie, "")).json()).toEqual({ threads: [] });
  });

  it("limits how often one person can ask", async () => {
    const { h, cookie, document } = await ready();
    const ask = () =>
      h.post(cookie, "", { question: "governing law", document_ids: [document.id] });
    for (let i = 0; i < 20; i++) expect((await ask()).status).toBe(201);
    const blocked = await ask();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await blocked.json()).toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});
