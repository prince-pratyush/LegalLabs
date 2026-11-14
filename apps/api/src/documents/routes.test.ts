import type { IngestResult } from "@legallabs/ingest";
import { createGateway } from "@legallabs/model-gateway";
import { createMemoryStore } from "@legallabs/storage";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { PASSWORD, type Seeded, seedMember, testPool } from "../test-db.js";
import { createThreads } from "../threads/threads.js";
import { createDocuments, type DocumentsOptions } from "./documents.js";

const pool = testPool();
afterAll(() => pool.end());

const CLAUSE = "The supplier accepts liability for direct loss.";

function harness(options: Partial<DocumentsOptions> = {}) {
  const app = createApp({
    auth: createAuth(pool),
    documents: createDocuments(pool, { store: createMemoryStore(), ...options }),
    threads: createThreads(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
      documents: createDocuments(pool, { store: createMemoryStore() }),
    }),
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
  const upload = (cookie: string, form: FormData, headers: Record<string, string> = {}) =>
    app.request("/api/v1/documents", {
      method: "POST",
      headers: { cookie, ...headers },
      body: form,
    });
  const get = (cookie: string, path: string) =>
    app.request(`/api/v1/documents${path}`, { headers: { cookie } });
  return { app, signIn, upload, get };
}

function formWith(name: string, content = CLAUSE, matterId?: string) {
  const form = new FormData();
  form.set("file", new File([content], name));
  if (matterId) form.set("matter_id", matterId);
  return form;
}

describe("documents API", () => {
  it("needs a session for every route", async () => {
    const h = harness();
    const responses = [
      await h.upload("", formWith("a.txt")),
      await h.get("", ""),
      await h.get("", "/search?q=liability"),
    ];
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "UNAUTHENTICATED" });
    }
  });

  it("uploads, lists and searches a document", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const cookie = await h.signIn(m);

    const created = await h.upload(cookie, formWith("msa.txt"));
    expect(created.status).toBe(201);
    const { document } = (await created.json()) as { document: Record<string, unknown> };
    expect(document).toMatchObject({
      name: "msa.txt",
      mime: "text/plain",
      page_count: 1,
      empty_page_count: 0,
      matter_id: null,
    });

    const listed = await h.get(cookie, "");
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(await listed.json()).toEqual({ documents: [document] });

    const found = await h.get(cookie, "/search?q=liability&limit=5");
    expect(await found.json()).toEqual({
      passages: [
        {
          chunk_id: expect.any(String),
          document_id: document.id,
          document_version_id: document.version_id,
          document_name: "msa.txt",
          page: 1,
          char_from: 0,
          char_to: CLAUSE.length,
          text: CLAUSE,
        },
      ],
    });
  });

  it("narrows a search to the documents asked for", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const cookie = await h.signIn(m);
    const created = await h.upload(cookie, formWith("wanted.txt"));
    const { document } = (await created.json()) as { document: { id: string } };
    await h.upload(cookie, formWith("other.txt"));
    const res = await h.get(cookie, `/search?q=liability&document_id=${document.id}`);
    const { passages } = (await res.json()) as { passages: { document_name: string }[] };
    expect(passages.map((p) => p.document_name)).toEqual(["wanted.txt"]);
  });

  it.each([
    ["no file", () => new FormData()],
    [
      "a file field that is plain text",
      () => {
        const form = new FormData();
        form.set("file", "just text");
        return form;
      },
    ],
    ["a malformed matter id", () => formWith("a.txt", CLAUSE, "not-a-uuid")],
    ["a control character in the name", () => formWith("a\u0007b.txt")],
    ["a direction override hiding the real extension", () => formWith("a‮txt.exe.txt")],
    ["a line separator in the name", () => formWith("a b.txt")],
    ["a name that is too long", () => formWith(`${"x".repeat(256)}.txt`)],
  ])("rejects %s", async (_, form) => {
    const m = await seedMember(pool);
    const h = harness();
    const res = await h.upload(await h.signIn(m), form());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects a body that isn't a form", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const res = await h.app.request("/api/v1/documents", {
      method: "POST",
      headers: { cookie: await h.signIn(m), "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("refuses a file over the size limit without reading it", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const res = await h.upload(await h.signIn(m), formWith("a.txt"), {
      "content-length": String(30 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("answers 403 without the permission", async () => {
    const m = await seedMember(pool, { permissions: [] });
    const h = harness();
    const res = await h.upload(await h.signIn(m), formWith("a.txt"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("answers 404 for a matter that can't be reached", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const res = await h.upload(
      await h.signIn(m),
      formWith("a.txt", CLAUSE, "00000000-0000-7000-8000-000000000001"),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "MATTER_NOT_FOUND" });
  });

  it.each([
    ["an unsupported type", "contract.docx", CLAUSE, 415, "UNSUPPORTED_TYPE"],
    ["a file with no text", "blank.txt", "   ", 422, "NO_TEXT"],
  ])("explains %s", async (_, name, content, status, code) => {
    const m = await seedMember(pool);
    const h = harness();
    const res = await h.upload(await h.signIn(m), formWith(name, content));
    expect(res.status).toBe(status);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe(code);
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("turns away a third upload while two are parsing", async () => {
    const m = await seedMember(pool);
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parsing = 0;
    let bothParsing = () => {};
    const ready = new Promise<void>((resolve) => {
      bothParsing = resolve;
    });
    const ingest = async (): Promise<IngestResult> => {
      parsing++;
      if (parsing === 2) bothParsing();
      await blocked;
      return { ok: false, reason: "NO_TEXT" };
    };
    const h = harness({ ingest });
    const cookie = await h.signIn(m);
    const first = h.upload(cookie, formWith("a.txt"));
    const second = h.upload(cookie, formWith("b.txt"));
    await ready;

    const third = await h.upload(cookie, formWith("c.txt"));
    expect(third.status).toBe(503);
    expect(third.headers.get("retry-after")).toBeTruthy();

    release();
    expect((await first).status).toBe(422);
    expect((await second).status).toBe(422);
    expect((await h.upload(cookie, formWith("d.txt"))).status).toBe(422);
  });

  it.each([
    ["no query", ""],
    ["an empty query", "?q="],
    ["a query with a NUL byte", "?q=a%00b"],
    ["a query that is too long", `?q=${"a".repeat(501)}`],
    ["a limit of zero", "?q=a&limit=0"],
    ["a limit too high", "?q=a&limit=51"],
    ["a limit that isn't a number", "?q=a&limit=many"],
    ["a malformed document id", "?q=a&document_id=nope"],
  ])("rejects a search with %s", async (_, query) => {
    const m = await seedMember(pool);
    const h = harness();
    const res = await h.get(await h.signIn(m), `/search${query}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });
});
