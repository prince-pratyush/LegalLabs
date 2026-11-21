import { createHash, randomUUID } from "node:crypto";
import { createGateway, type Message, type ModelProvider } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { Principal } from "../auth/auth.js";
import { createAuth } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
import { createDrafts } from "../drafts/drafts.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { parseCsv } from "./csv.js";
import { createMemoryModule } from "./module.js";
import { detectRemember, extractCandidates } from "./prompt.js";
import type { SampleReader } from "./styles.js";

const pool = testPool();
afterAll(() => pool.end());

const CLAUSE = "The supplier accepts liability for direct loss up to the fees paid.";
const ANSWER =
  'The supplier is liable.<c doc="D1" page="1" quote="accepts liability for direct loss"/>';
const client = { ip: "203.0.113.9", userAgent: "vitest" };

// Stands in for the model: answers questions, proposes onboarding memories and a style.
function model() {
  const calls: { stream: boolean; messages: readonly Message[] }[] = [];
  const reply = (messages: readonly Message[]) => {
    const system = messages[0]?.content ?? "";
    if (system.includes("onboarding questions")) {
      return "- Partner in the litigation team\n- Cites pin points\n* Prefers British spelling\n";
    }
    if (system.includes("describe a writer's style")) return "Short sentences. Formal tone.";
    return ANSWER;
  };
  const provider: ModelProvider = {
    complete: async ({ messages }) => {
      calls.push({ stream: false, messages });
      return { text: reply(messages), usage: { input_tokens: 100, output_tokens: 20 } };
    },
    stream: async ({ messages }, onText) => {
      calls.push({ stream: true, messages });
      const text = reply(messages);
      onText(text);
      return { text, usage: { input_tokens: 100, output_tokens: 20 } };
    },
  };
  const prompts = () => calls.filter((c) => c.stream).map((c) => c.messages);
  return { provider, calls, prompts };
}

// A file is its pages joined by form feeds, so a test can say how long a sample is.
const read: SampleReader = async (bytes) => {
  const text = new TextDecoder().decode(bytes);
  const pages = text.split("\f").map((body, i) => ({
    pageNo: i + 1,
    width: 1,
    height: 1,
    text: body,
    blocks: [],
  }));
  return { ok: true, mime: "text/plain", pages, chunks: [], emptyPageCount: 0 };
};

function harness(infer = false) {
  const fake = model();
  const documents = testDocuments(pool);
  const gateway = createGateway({
    providers: { anthropic: fake.provider },
    recordUsage: async () => {},
  });
  const memory = createMemoryModule(pool, { gateway, read, infer });
  const threads = testThreads(pool, documents, { anthropic: fake.provider }, undefined, undefined, {
    personalisation: memory.personalisation,
  });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads,
    drafts: createDrafts(pool, { gateway }),
    memory,
    clientIp: () => "203.0.113.9",
  });
  const signIn = async (m: Pick<Seeded, "slug" | "email">) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const call = async (cookie: string, method: string, path: string, json?: unknown, extra = {}) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: {
        cookie,
        ...(json === undefined ? {} : { "content-type": "application/json" }),
        ...extra,
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: the tests read many different response shapes
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, body, headers: res.headers };
  };
  const form = async (cookie: string, path: string, fields: Record<string, string | File>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    const res = await app.request(`/api/v1${path}`, {
      method: "POST",
      headers: { cookie },
      body: data,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const ask = async (
    cookie: string,
    m: Seeded,
    content: string,
    extra: Record<string, unknown> = {},
  ) => {
    const principal: Principal = {
      sessionId: "00000000-0000-7000-8000-000000000000",
      userId: m.userId,
      workspaceId: m.workspaceId,
    };
    const uploaded = await documents.upload(
      principal,
      { name: "msa.txt", bytes: new TextEncoder().encode(CLAUSE), matterId: null },
      client,
    );
    if (!uploaded.ok) throw new Error(uploaded.reason);
    const started = await call(cookie, "POST", "/threads", {
      content,
      scope: { document_ids: [uploaded.document.id] },
      ...extra,
    });
    expect(started.status).toBe(202);
    await threads.threads.settled();
    const run = await call(cookie, "GET", `/runs/${started.body.run_id}`);
    return { messageId: run.body.run.message_id as string, run: run.body.run };
  };
  return { ...fake, signIn, call, form, ask, memory, threads };
}

type Harness = ReturnType<typeof harness>;

// Another person in the same workspace, holding exactly the permissions given.
async function colleague(m: Seeded, permissions: string[]): Promise<Seeded> {
  const email = `c-${randomUUID().slice(0, 6)}@${m.slug}.test`;
  const role = await pool.query<{ id: string }>(
    "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
    [m.workspaceId, `Role ${email}`, permissions],
  );
  const user = await pool.query<{ id: string }>(
    `insert into core."user" (workspace_id, email, role_id, status) values ($1, $2, $3, 'active') returning id`,
    [m.workspaceId, email, role.rows[0]?.id],
  );
  const userId = user.rows[0]?.id ?? "";
  await pool.query(
    "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
    [m.workspaceId, userId, await hashPassword(PASSWORD)],
  );
  return { slug: m.slug, email, userId, workspaceId: m.workspaceId };
}

const MEMBER = ["threads.use", "memory.use"];

async function member(h: Harness, permissions = MEMBER) {
  const admin = await seedMember(pool);
  const m = await colleague(admin, permissions);
  return { admin, m, cookie: await h.signIn(m), adminCookie: await h.signIn(admin) };
}

const hash = (text: string) => createHash("sha256").update(text.toLowerCase()).digest("hex");

// Many memories at once, written as the table owner.
async function seedMemories(m: Seeded, count: number, prefix = "Existing memory") {
  await pool.query(
    `insert into memory.memory (workspace_id, user_id, text, source, normalized_hash)
     select $1, $2, $3 || ' ' || n, 'manual',
            encode(sha256(convert_to(lower($3 || ' ' || n), 'utf8')), 'hex')
       from generate_series(1, $4::int) n`,
    [m.workspaceId, m.userId, prefix, count],
  );
}

describe("memories", () => {
  it("are created, listed, edited and deleted, with the text kept out of the audit log", async () => {
    const h = harness();
    const { m, cookie } = await member(h);

    const made = await h.call(cookie, "POST", "/memory", { text: "  Use UK spelling  " });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ text: "Use UK spelling", source: "manual" });
    const id = made.body.id as string;

    const listed = await h.call(cookie, "GET", "/memory");
    expect(listed.body).toMatchObject({ count: 1, limit: 1000, enabled: true });
    expect(listed.body.items).toHaveLength(1);

    // The same words again, in another case, are the same memory.
    expect((await h.call(cookie, "POST", "/memory", { text: "use uk spelling." })).status).toBe(
      409,
    );

    const edited = await h.call(cookie, "PATCH", `/memory/${id}`, { text: "Use US spelling" });
    expect(edited.body.text).toBe("Use US spelling");
    expect((await h.call(cookie, "GET", "/memory?q=us%20spell")).body.items).toHaveLength(1);
    expect((await h.call(cookie, "GET", "/memory?source=imported")).body.items).toHaveLength(0);

    expect((await h.call(cookie, "DELETE", `/memory/${id}`)).status).toBe(204);
    expect((await h.call(cookie, "DELETE", `/memory/${id}`)).status).toBe(404);
    expect((await h.call(cookie, "GET", "/memory")).body.count).toBe(0);

    const trail = await auditTrail(pool, m.workspaceId);
    const actions = trail.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["memory.created", "memory.updated", "memory.deleted"]),
    );
    const text = JSON.stringify(trail);
    expect(text).not.toMatch(/spelling/i);
    expect(trail.find((e) => e.action === "memory.created")?.details).toEqual({ source: "manual" });
  });

  it("refuse text over 1,000 characters and a 1,001st memory", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    const long = await h.call(cookie, "POST", "/memory", { text: "x".repeat(1001) });
    expect(long).toMatchObject({ status: 400, body: { code: "LIMIT_MEMORY_LENGTH" } });
    // 1,000 code points, two UTF-16 units each, is still fine.
    expect((await h.call(cookie, "POST", "/memory", { text: "😀".repeat(1000) })).status).toBe(201);

    await seedMemories(m, 999);
    const over = await h.call(cookie, "POST", "/memory", { text: "One more" });
    expect(over).toMatchObject({ status: 409, body: { code: "LIMIT_MEMORIES" } });
  });

  it("flag an opposite pair, and the newer one is the one that wins", async () => {
    const h = harness();
    const { cookie } = await member(h);
    const uk = await h.call(cookie, "POST", "/memory", { text: "Use UK spelling" });
    const us = await h.call(cookie, "POST", "/memory", { text: "Use US spelling" });
    const items = (await h.call(cookie, "GET", "/memory")).body.items as {
      id: string;
      conflicts_with?: string[];
    }[];
    expect(items.find((i) => i.id === uk.body.id)?.conflicts_with).toEqual([us.body.id]);
    expect(items.find((i) => i.id === us.body.id)?.conflicts_with).toEqual([uk.body.id]);
  });

  it("need memory.use, and one person's are never another's, admins included", async () => {
    const h = harness();
    const { admin, m, cookie, adminCookie } = await member(h);
    await h.call(cookie, "POST", "/memory", { text: "Cite pin points" });

    // The workspace admin ("*") reads, lists and exports none of it.
    const adminList = await h.call(adminCookie, "GET", "/memory");
    expect(adminList.body).toMatchObject({ items: [], count: 0 });
    expect((await h.call(adminCookie, "GET", "/memory/export")).body).not.toMatch(/pin points/);
    const id = (await h.call(cookie, "GET", "/memory")).body.items[0].id as string;
    expect((await h.call(adminCookie, "PATCH", `/memory/${id}`, { text: "x" })).status).toBe(404);
    expect((await h.call(adminCookie, "DELETE", `/memory/${id}`)).status).toBe(404);
    expect((await h.call(cookie, "GET", "/memory")).body.count).toBe(1);
    expect(admin.userId).not.toBe(m.userId);

    const bare = await colleague(admin, ["threads.use"]);
    const bareCookie = await h.signIn(bare);
    expect((await h.call(bareCookie, "GET", "/memory")).status).toBe(403);
    expect((await h.call(bareCookie, "POST", "/memory", { text: "x" })).status).toBe(403);
    expect((await h.call(bareCookie, "GET", "/memory/settings")).body).toMatchObject({
      permitted: false,
    });
  });

  it("delete all only with a confirmation header", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    await seedMemories(m, 3);
    expect((await h.call(cookie, "DELETE", "/memory")).status).toBe(400);
    expect((await h.call(cookie, "GET", "/memory")).body.count).toBe(3);
    expect(
      (await h.call(cookie, "DELETE", "/memory", undefined, { "x-confirm": "all" })).status,
    ).toBe(204);
    expect((await h.call(cookie, "GET", "/memory")).body.count).toBe(0);
    const trail = await auditTrail(pool, m.workspaceId);
    expect(trail.find((e) => e.action === "memory.all_deleted")?.details).toEqual({ count: 3 });
  });

  it("can be switched off and on, and each switch is audited", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    expect((await h.call(cookie, "GET", "/memory/settings")).body).toEqual({
      use_memory: true,
      permitted: true,
      pending_candidates: 0,
    });
    expect(
      (await h.call(cookie, "PATCH", "/memory/settings", { use_memory: false })).body,
    ).toMatchObject({
      use_memory: false,
    });
    await h.call(cookie, "PATCH", "/memory/settings", { use_memory: false });
    await h.call(cookie, "PATCH", "/memory/settings", { use_memory: true });
    expect((await h.call(cookie, "GET", "/memory")).body.enabled).toBe(true);
    const actions = (await auditTrail(pool, m.workspaceId)).map((e) => e.action);
    expect(actions.filter((a) => a === "memory.disabled")).toHaveLength(1);
    expect(actions.filter((a) => a === "memory.enabled")).toHaveLength(1);
  });
});

describe("memory candidates", () => {
  it("wait for the user: accepted ones become memories, dismissed ones never do", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    const principal: Principal = {
      sessionId: randomUUID(),
      userId: m.userId,
      workspaceId: m.workspaceId,
    };
    const added = await h.memory.memories.propose(principal, randomUUID(), [
      "Always address opposing counsel formally",
      "Prefers short paragraphs",
      "Always address opposing counsel formally",
    ]);
    expect(added).toBe(2);
    expect((await h.call(cookie, "GET", "/memory")).body.count).toBe(0);

    const pending = (await h.call(cookie, "GET", "/memory/candidates")).body.items as {
      id: string;
      text: string;
      expires_at: string;
      from_message_id: string;
    }[];
    expect(pending).toHaveLength(2);
    expect(Date.parse(pending[0]?.expires_at ?? "") - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect((await h.call(cookie, "GET", "/memory/settings")).body.pending_candidates).toBe(2);

    const [first, second] = pending as [(typeof pending)[0], (typeof pending)[0]];
    const accepted = await h.call(cookie, "POST", `/memory/candidates/${first.id}/accept`, {
      text: "Address opposing counsel formally",
    });
    expect(accepted.body).toMatchObject({
      text: "Address opposing counsel formally",
      source: "inferred",
    });
    expect((await h.call(cookie, "POST", `/memory/candidates/${second.id}/dismiss`)).status).toBe(
      204,
    );
    expect((await h.call(cookie, "GET", "/memory")).body.count).toBe(1);
    expect((await h.call(cookie, "GET", "/memory/candidates")).body.items).toEqual([]);
    expect(
      (await h.call(cookie, "POST", `/memory/candidates/${second.id}/accept`, {})).status,
    ).toBe(404);

    const decisions = await pool.query(
      "select decision from memory.memory_candidate where user_id = $1 order by decision",
      [m.userId],
    );
    expect(decisions.rows.map((r) => r.decision)).toEqual(["accepted", "dismissed"]);
  });

  it("are at most five a turn and twenty pending, the oldest dismissed", async () => {
    const h = harness();
    const { m } = await member(h);
    const principal: Principal = {
      sessionId: randomUUID(),
      userId: m.userId,
      workspaceId: m.workspaceId,
    };
    const turn = (n: number) => Array.from({ length: 8 }, (_, i) => `Preference ${n}-${i}`);
    expect(await h.memory.memories.propose(principal, randomUUID(), turn(1))).toBe(5);
    for (const n of [2, 3, 4, 5]) await h.memory.memories.propose(principal, randomUUID(), turn(n));
    const rows = await pool.query(
      `select count(*) filter (where decided_at is null) as pending,
              count(*) filter (where decision = 'dismissed') as dismissed
         from memory.memory_candidate where user_id = $1`,
      [m.userId],
    );
    expect(rows.rows[0]).toEqual({ pending: "20", dismissed: "5" });
    const oldest = await pool.query(
      "select text from memory.memory_candidate where user_id = $1 and decision = 'dismissed' order by text",
      [m.userId],
    );
    expect(oldest.rows.every((r) => String(r.text).startsWith("Preference 1-"))).toBe(true);
  });

  it("are purged once 30 days have passed", async () => {
    const h = harness();
    const { m } = await member(h);
    const principal: Principal = {
      sessionId: randomUUID(),
      userId: m.userId,
      workspaceId: m.workspaceId,
    };
    await h.memory.memories.propose(principal, randomUUID(), ["Prefers headings"]);
    const purge = (days: number) =>
      pool.query("select * from memory.purge(now() + make_interval(days => $1))", [days]);
    await purge(29);
    expect(
      (await pool.query("select 1 from memory.memory_candidate where user_id = $1", [m.userId]))
        .rowCount,
    ).toBe(1);
    await purge(31);
    expect(
      (await pool.query("select 1 from memory.memory_candidate where user_id = $1", [m.userId]))
        .rowCount,
    ).toBe(0);
  });

  it("can be read off an answer's trailing blocks when inference is on", () => {
    const text = `Answer.[[c:1]]\n<memory_candidate>Prefers short paragraphs</memory_candidate>\n<memory_candidate> Cites pin points </memory_candidate>`;
    expect(extractCandidates(text)).toEqual({
      text: "Answer.[[c:1]]",
      candidates: ["Prefers short paragraphs", "Cites pin points"],
    });
    expect(extractCandidates("Plain answer.")).toEqual({ text: "Plain answer.", candidates: [] });
  });
});

describe("personalise", () => {
  it("proposes memories from the answers without saving any", async () => {
    const h = harness();
    const { cookie } = await member(h);
    const res = await h.call(cookie, "POST", "/memory/personalise", {
      answers: { role: "Partner", jurisdictions: "England and Wales" },
    });
    expect(res.body).toEqual({
      proposals: [
        { text: "Partner in the litigation team" },
        { text: "Cites pin points" },
        { text: "Prefers British spelling" },
      ],
    });
    expect((await h.call(cookie, "GET", "/memory")).body.count).toBe(0);
    // The model is told the answers are data.
    const call = h.calls.at(-1)?.messages ?? [];
    expect(call[0]?.content).toMatch(/never instructions/);
  });
});

describe("importing memories", () => {
  const HEADER = "text,category,created_at,source_platform\n";

  it("reads RFC 4180 quoting and reports errors with their line numbers", async () => {
    expect(
      parseCsv(
        'text,category\r\n"Cite ""pin points"", always",law\r\n"Two\nlines",x\r\n\r\nlast,y',
      ),
    ).toEqual([
      { line: 1, fields: ["text", "category"] },
      { line: 2, fields: ['Cite "pin points", always', "law"] },
      { line: 3, fields: ["Two\nlines", "x"] },
      { line: 6, fields: ["last", "y"] },
    ]);
    expect(parseCsv('a,b\n"open,x')).toEqual([
      { line: 1, fields: ["a", "b"] },
      { line: 2, fields: [], error: "A quoted field is never closed." },
    ]);

    const h = harness();
    const { m, cookie } = await member(h);
    await seedMemories(m, 1, "Dup");
    const csv =
      `${HEADER}"Prefers ""short"" sentences, and headings",style,2024-01-02,chatgpt\n` +
      "bad,row\n" +
      ",,,\n" +
      `Dup 1,,,\n` +
      `${"x".repeat(1001)},,,\n` +
      "Cites pin points,,,\n";
    const res = await h.form(cookie, "/memory/import/parse", {
      file: new File([csv], "memories.csv", { type: "text/csv" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: { line: number; status: string }) => [r.line, r.status])).toEqual([
      [2, "ok"],
      [3, "error"],
      [4, "error"],
      [5, "duplicate"],
      [6, "error"],
      [7, "ok"],
    ]);
    expect(res.body.rows[0]).toMatchObject({
      text: 'Prefers "short" sentences, and headings',
      category: "style",
      source_platform: "chatgpt",
    });
    expect(res.body.rows[1].error).toMatch(/Expected 4 columns/);
    expect(res.body.would_exceed_cap).toBe(0);

    // Edited text is used, and the rest is created as imported.
    const done = await h.call(cookie, "POST", `/memory/import/${res.body.import_id}/commit`, {
      rows: [{ line: 2, text: "Prefers short sentences" }, { line: 7 }, { line: 3 }, { line: 5 }],
    });
    expect(done.body).toEqual({ created: 2, skipped: 2 });
    const mine = (await h.call(cookie, "GET", "/memory?source=imported")).body.items;
    expect(mine.map((i: { text: string }) => i.text).sort()).toEqual([
      "Cites pin points",
      "Prefers short sentences",
    ]);
    // An upload is committed once.
    expect(
      (
        await h.call(cookie, "POST", `/memory/import/${res.body.import_id}/commit`, {
          rows: [{ line: 7 }],
        })
      ).status,
    ).toBe(404);
    const trail = await auditTrail(pool, m.workspaceId);
    expect(trail.find((e) => e.action === "memory.imported")?.details).toEqual({
      count: 2,
      skipped: 2,
    });
    expect(JSON.stringify(trail)).not.toMatch(/pin points/i);
  });

  it("rejects a file with no text column, or that is not UTF-8", async () => {
    const h = harness();
    const { cookie } = await member(h);
    const noText = await h.form(cookie, "/memory/import/parse", {
      file: new File(["note,category\nx,y\n"], "m.csv"),
    });
    expect(noText).toMatchObject({ status: 400, body: { code: "IMPORT_INVALID" } });
    const binary = await h.form(cookie, "/memory/import/parse", {
      file: new File([new Uint8Array([0xff, 0xfe, 0x00, 0x41])], "m.csv"),
    });
    expect(binary.status).toBe(400);
  });

  it("stops at the 1,000 cap: 1,200 rows, 10 malformed, 50 duplicates, 900 held", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    await seedMemories(m, 900);

    const lines: string[] = [HEADER.trimEnd()];
    for (let i = 1; i <= 5; i++) lines.push(`broken ${i},row`);
    for (let i = 1; i <= 5; i++) lines.push(",,,");
    for (let i = 1; i <= 50; i++) lines.push(`Existing memory ${i},,,`);
    for (let i = 1; i <= 1140; i++) lines.push(`Imported preference ${i},imported,,other`);
    const csv = `${lines.join("\n")}\n`;
    expect(lines.length - 1).toBe(1200);

    const parsed = await h.form(cookie, "/memory/import/parse", {
      file: new File([csv], "all.csv"),
    });
    expect(parsed.status).toBe(200);
    const rows = parsed.body.rows as { line: number; status: string }[];
    expect(rows).toHaveLength(1200);
    expect(rows.filter((r) => r.status === "error").map((r) => r.line)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(rows.filter((r) => r.status === "duplicate")).toHaveLength(50);
    expect(rows.filter((r) => r.status === "ok")).toHaveLength(1140);
    expect(parsed.body.would_exceed_cap).toBe(1040);

    const ok = rows.filter((r) => r.status === "ok").map((r) => ({ line: r.line }));
    const done = await h.call(cookie, "POST", `/memory/import/${parsed.body.import_id}/commit`, {
      rows: ok,
    });
    expect(done.body).toEqual({ created: 100, skipped: 1040 });
    expect((await h.call(cookie, "GET", "/memory")).body.count).toBe(1000);
  });

  it("exports the user's memories as CSV that imports back, defusing formulas", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    await h.call(cookie, "POST", "/memory", { text: 'Cite "pin points", always' });
    await h.call(cookie, "POST", "/memory", { text: "=SUM(A1) is not a preference" });
    const res = await h.call(cookie, "GET", "/memory/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const records = parseCsv(res.body as string);
    expect(records[0]?.fields).toEqual(["text", "category", "created_at", "source_platform"]);
    expect(records.map((r) => r.fields[0])).toEqual([
      "text",
      'Cite "pin points", always',
      "'=SUM(A1) is not a preference",
    ]);
    const trail = await auditTrail(pool, m.workspaceId);
    expect(trail.find((e) => e.action === "memory.exported")?.details).toEqual({ count: 2 });
  });
});

describe("answering with memory", () => {
  const spellingMemory = async (h: Harness, cookie: string, text = "Use UK spelling") =>
    h.call(cookie, "POST", "/memory", { text });

  it("puts memories in the system prompt after the citation contract, and tells the author", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    await spellingMemory(h, cookie);
    await spellingMemory(h, cookie, "Always cite pin points");
    const { messageId } = await h.ask(cookie, m, "Who is liable?");

    const system = h.prompts().at(-1)?.[0]?.content ?? "";
    expect(system.indexOf("An answer without a tag after each claim is wrong")).toBeGreaterThan(-1);
    expect(system.indexOf("Use UK spelling")).toBeGreaterThan(
      system.indexOf("An answer without a tag after each claim is wrong"),
    );
    expect(system).toMatch(/citation and grounding rules above always win/);
    expect(system).toContain("Always cite pin points");

    const use = await h.call(cookie, "GET", `/memory/use/${messageId}`);
    expect(use.body.used.map((u: { text: string }) => u.text).sort()).toEqual([
      "Always cite pin points",
      "Use UK spelling",
    ]);
    expect(use.body.not_applied).toEqual([]);
  });

  it("shows the Memory used chip to its author only, never in a thread view or to an admin", async () => {
    const h = harness();
    const { admin, m, cookie, adminCookie } = await member(h);
    await spellingMemory(h, cookie);
    const { messageId } = await h.ask(cookie, m, "Who is liable?");
    expect((await h.call(adminCookie, "GET", `/memory/use/${messageId}`)).status).toBe(404);
    const other = await colleague(admin, MEMBER);
    expect((await h.call(await h.signIn(other), "GET", `/memory/use/${messageId}`)).status).toBe(
      404,
    );
    // Nothing about memory rides on the message itself.
    const stored = await pool.query("select to_jsonb(m) as j from work.message m where id = $1", [
      messageId,
    ]);
    expect(JSON.stringify(stored.rows[0]?.j)).not.toMatch(/memory|spelling/i);
  });

  it("sends no memory text to the model when memory is off, and records nothing", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    await spellingMemory(h, cookie, "Zebra preference");
    await h.call(cookie, "PATCH", "/memory/settings", { use_memory: false });
    const { messageId } = await h.ask(cookie, m, "Who is liable?");
    for (const request of h.calls) {
      expect(JSON.stringify(request.messages)).not.toContain("Zebra preference");
    }
    expect((await h.call(cookie, "GET", `/memory/use/${messageId}`)).status).toBe(404);
    const rows = await pool.query("select 1 from memory.message_use where user_id = $1", [
      m.userId,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it("lets the composer override the setting for one thread", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    await spellingMemory(h, cookie, "Zebra preference");
    await h.ask(cookie, m, "Who is liable?", { use_memory: false });
    expect(JSON.stringify(h.prompts().at(-1))).not.toContain("Zebra preference");
    await h.call(cookie, "PATCH", "/memory/settings", { use_memory: false });
    await h.ask(cookie, m, "Who is liable now?", { use_memory: true });
    expect(JSON.stringify(h.prompts().at(-1))).toContain("Zebra preference");
  });

  it("lets the prompt win: a UK memory against a US request is listed as not applied", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    const uk = await spellingMemory(h, cookie, "Use UK spelling");
    await spellingMemory(h, cookie, "Always cite pin points");
    const { messageId } = await h.ask(cookie, m, "Who is liable? Please use US spelling.");
    expect(JSON.stringify(h.prompts().at(-1)?.[0])).not.toContain("Use UK spelling");
    expect(JSON.stringify(h.prompts().at(-1)?.[0])).toContain("Always cite pin points");
    const use = await h.call(cookie, "GET", `/memory/use/${messageId}`);
    expect(use.body.not_applied).toEqual([{ id: uk.body.id, text: "Use UK spelling" }]);
    expect(use.body.used.map((u: { text: string }) => u.text)).toEqual(["Always cite pin points"]);
  });

  it("applies the newer of two opposite memories", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    const uk = await spellingMemory(h, cookie, "Use UK spelling");
    await new Promise((r) => setTimeout(r, 15));
    await spellingMemory(h, cookie, "Use US spelling");
    const { messageId } = await h.ask(cookie, m, "Who is liable?");
    const system = h.prompts().at(-1)?.[0]?.content ?? "";
    expect(system).toContain("Use US spelling");
    expect(system).not.toContain("Use UK spelling");
    const use = await h.call(cookie, "GET", `/memory/use/${messageId}`);
    expect(use.body.not_applied.map((u: { id: string }) => u.id)).toEqual([uk.body.id]);
  });

  it("selects the 40 most relevant memories when there are more", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    await seedMemories(m, 60, "Filler preference number");
    await pool.query(
      `insert into memory.memory (workspace_id, user_id, text, source, normalized_hash)
       values ($1, $2, 'Indemnity wording should be reciprocal', 'manual', $3)`,
      [m.workspaceId, m.userId, hash("Indemnity wording should be reciprocal")],
    );
    const { messageId } = await h.ask(cookie, m, "Review the indemnity wording");
    const system = h.prompts().at(-1)?.[0]?.content ?? "";
    expect(system).toContain("Indemnity wording should be reciprocal");
    expect(system.match(/^- /gm)).toHaveLength(40);
    const use = await h.call(cookie, "GET", `/memory/use/${messageId}`);
    expect(use.body.used).toHaveLength(40);
  });

  it("makes a memory from 'remember that ...' with an Undo that deletes it", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    const { messageId } = await h.ask(
      cookie,
      m,
      "Who is liable? Remember that I prefer Oxford commas.",
    );
    const memories = await h.call(cookie, "GET", "/memory?source=asked");
    expect(memories.body.items).toHaveLength(1);
    expect(memories.body.items[0].text).toBe("I prefer Oxford commas.");
    // The answer already follows it.
    expect(h.prompts().at(-1)?.[0]?.content).toContain("I prefer Oxford commas.");

    const use = await h.call(cookie, "GET", `/memory/use/${messageId}`);
    expect(use.body.created).toEqual([
      { id: memories.body.items[0].id, text: "I prefer Oxford commas." },
    ]);
    expect((await h.call(cookie, "DELETE", `/memory/${use.body.created[0].id}`)).status).toBe(204);
    expect((await h.call(cookie, "GET", "/memory")).body.count).toBe(0);
    const trail = await auditTrail(pool, m.workspaceId);
    expect(trail.find((e) => e.action === "memory.created")?.details).toEqual({ source: "asked" });
  });

  it("keeps memory text out of audit details and model-call records", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    await spellingMemory(h, cookie, "Zebra preference");
    await h.ask(cookie, m, "Who is liable? Remember that I like giraffes.");
    const trail = JSON.stringify(await auditTrail(pool, m.workspaceId));
    expect(trail).not.toMatch(/zebra|giraffe/i);
    const message = await pool.query("select * from work.message where workspace_id = $1", [
      m.workspaceId,
    ]);
    expect(JSON.stringify(message.rows)).not.toMatch(/zebra preference/i);
  });

  it("detects asked memories by a plain rule", () => {
    expect(detectRemember("Remember that I prefer British spelling").texts).toEqual([
      "I prefer British spelling",
    ]);
    expect(detectRemember("Draft a letter. Please remember to use headings.").texts).toEqual([
      "use headings.",
    ]);
    expect(detectRemember("remember: always cite pin points").texts).toEqual([
      "always cite pin points",
    ]);
    expect(detectRemember("Do you remember the client's name?")).toEqual({ texts: [], refused: 0 });
    expect(detectRemember("Remember that the client is Acme Pty Ltd")).toEqual({
      texts: [],
      refused: 1,
    });
  });
});

describe("writing styles", () => {
  const sample = (pages: number, text = "Short, clear sentences. Plain words.") =>
    new File([Array.from({ length: pages }, () => text).join("\f")], "sample.txt");

  it("are made from typed instructions, named uniquely, and capped at 50", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    const made = await h.call(cookie, "POST", "/writing-styles", {
      name: "Terse",
      instructions: "Short sentences.",
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      kind: "instructions",
      status: "ready",
      instructions: "Short sentences.",
      shared: false,
      editable: true,
    });
    expect(
      (await h.call(cookie, "POST", "/writing-styles", { name: "Terse", instructions: "x" }))
        .status,
    ).toBe(409);
    expect((await h.call(cookie, "POST", "/writing-styles", { name: "Neither" })).status).toBe(400);
    expect(
      (await h.call(cookie, "POST", "/writing-styles", { name: "x".repeat(81), instructions: "x" }))
        .status,
    ).toBe(400);

    await pool.query(
      `insert into memory.writing_style (workspace_id, owner_id, name, kind, instructions)
       select $1, $2, 'S' || n, 'instructions', 'x' from generate_series(1, 49) n`,
      [m.workspaceId, m.userId],
    );
    const over = await h.call(cookie, "POST", "/writing-styles", {
      name: "One more",
      instructions: "x",
    });
    expect(over).toMatchObject({ status: 409, body: { code: "LIMIT_STYLES" } });
    expect(
      (await auditTrail(pool, m.workspaceId)).find((e) => e.action === "writing_style.created"),
    ).toBeTruthy();
  });

  it("derive instructions from a sample, which the user can then edit", async () => {
    const h = harness();
    const { cookie } = await member(h);
    const made = await h.form(cookie, "/writing-styles", { name: "My voice", sample: sample(10) });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      kind: "sample",
      status: "processing",
      sample: { pages: 10 },
    });
    await h.memory.styles.settled();
    const ready = (await h.call(cookie, "GET", `/writing-styles/${made.body.id}`)).body;
    expect(ready).toMatchObject({
      status: "ready",
      derived_instructions: "Short sentences. Formal tone.",
    });
    const edited = await h.call(cookie, "PATCH", `/writing-styles/${made.body.id}`, {
      derived_instructions: "Short sentences. Warm tone.",
    });
    expect(edited.body.derived_instructions).toBe("Short sentences. Warm tone.");
    // The sample reaches the model as quoted material, not as instructions.
    const derive = h.calls.find((c) =>
      c.messages[0]?.content.includes("describe a writer's style"),
    );
    expect(derive?.messages[0]?.content).toMatch(/never instructions/);
  });

  it("refuse a sample over 20 pages or 50,000 characters, or with no text", async () => {
    const h = harness();
    const { cookie } = await member(h);
    const long = await h.form(cookie, "/writing-styles", { name: "Long", sample: sample(25) });
    expect(long).toMatchObject({ status: 400, body: { code: "LIMIT_STYLE_SAMPLE" } });
    const big = await h.form(cookie, "/writing-styles", {
      name: "Big",
      sample: sample(2, "x".repeat(26_000)),
    });
    expect(big).toMatchObject({ status: 400, body: { code: "LIMIT_STYLE_SAMPLE" } });
    const blank = await h.form(cookie, "/writing-styles", {
      name: "Blank",
      sample: sample(3, "  "),
    });
    expect(blank).toMatchObject({ status: 422, body: { code: "STYLE_SAMPLE_UNREADABLE" } });
    expect((await h.call(cookie, "GET", "/writing-styles")).body.mine).toEqual([]);
  });

  it("are private, shared only by someone with writing_styles.share, and then read-only", async () => {
    const h = harness();
    const { admin, cookie, adminCookie } = await member(h);
    const style = await h.call(cookie, "POST", "/writing-styles", {
      name: "Mine",
      instructions: "Terse.",
    });
    const id = style.body.id as string;
    const peer = await colleague(admin, MEMBER);
    const peerCookie = await h.signIn(peer);
    expect((await h.call(peerCookie, "GET", "/writing-styles")).body).toEqual({
      mine: [],
      workspace: [],
    });

    // Without the permission, sharing is refused.
    expect(
      (await h.call(cookie, "POST", `/writing-styles/${id}/share`, { shared: true })).status,
    ).toBe(403);

    // An admin shares their own, and it shows under Workspace for everyone.
    const adminStyle = await h.call(adminCookie, "POST", "/writing-styles", {
      name: "House",
      instructions: "Formal.",
    });
    const shared = await h.call(
      adminCookie,
      "POST",
      `/writing-styles/${adminStyle.body.id}/share`,
      {
        shared: true,
      },
    );
    expect(shared.body).toMatchObject({ shared: true });
    const seen = (await h.call(peerCookie, "GET", "/writing-styles")).body;
    expect(seen.mine).toEqual([]);
    expect(seen.workspace).toEqual([expect.objectContaining({ name: "House", editable: false })]);
    // Read-only to others.
    expect(
      (
        await h.call(peerCookie, "PATCH", `/writing-styles/${adminStyle.body.id}`, {
          name: "Mine now",
        })
      ).status,
    ).toBe(404);
    expect(
      (await h.call(peerCookie, "DELETE", `/writing-styles/${adminStyle.body.id}`)).status,
    ).toBe(404);

    // An admin takes back someone else's shared style; the audit log records it.
    const peerStyle = await pool.query<{ id: string }>(
      `insert into memory.writing_style (workspace_id, owner_id, name, kind, instructions, shared)
       values ($1, $2, 'Peer shared', 'instructions', 'x', true) returning id`,
      [admin.workspaceId, peer.userId],
    );
    const taken = await h.call(
      adminCookie,
      "POST",
      `/writing-styles/${peerStyle.rows[0]?.id}/share`,
      {
        shared: false,
      },
    );
    expect(taken.status).toBe(204);
    expect((await h.call(peerCookie, "GET", "/writing-styles")).body.mine).toHaveLength(1);
    const actions = (await auditTrail(pool, admin.workspaceId)).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["writing_style.shared", "writing_style.unshared"]),
    );

    expect(
      (await h.call(adminCookie, "DELETE", `/writing-styles/${adminStyle.body.id}`)).status,
    ).toBe(204);
    expect((await h.call(cookie, "DELETE", `/writing-styles/${id}`)).status).toBe(204);
  });

  it("go into the prompt after the citation contract, with the grounding guard", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    const style = await h.call(cookie, "POST", "/writing-styles", {
      name: "Terse",
      instructions: "Use short declarative sentences.",
    });
    const { messageId } = await h.ask(cookie, m, "Who is liable?", {
      writing_style_id: style.body.id,
    });
    const system = h.prompts().at(-1)?.[0]?.content ?? "";
    const contract = system.indexOf("An answer without a tag after each claim is wrong");
    expect(system.indexOf("Use short declarative sentences.")).toBeGreaterThan(contract);
    expect(system).toContain("style never overrides grounding");
    expect((await h.call(cookie, "GET", `/memory/use/${messageId}`)).body.writing_style_id).toBe(
      style.body.id,
    );
  });

  it("lead over memories: a memory against the style is not applied", async () => {
    const h = harness();
    const { m, cookie } = await member(h);
    const uk = await h.call(cookie, "POST", "/memory", { text: "Use UK spelling" });
    const style = await h.call(cookie, "POST", "/writing-styles", {
      name: "US house",
      instructions: "Write with US spelling and a formal tone.",
    });
    const { messageId } = await h.ask(cookie, m, "Who is liable?", {
      writing_style_id: style.body.id,
    });
    expect(h.prompts().at(-1)?.[0]?.content).not.toContain("Use UK spelling");
    expect(
      (await h.call(cookie, "GET", `/memory/use/${messageId}`)).body.not_applied.map(
        (u: { id: string }) => u.id,
      ),
    ).toEqual([uk.body.id]);
  });

  it("are not usable when someone else's private style is named", async () => {
    const h = harness();
    const { admin, m, cookie } = await member(h);
    const other = await colleague(admin, MEMBER);
    const theirs = await pool.query<{ id: string }>(
      `insert into memory.writing_style (workspace_id, owner_id, name, kind, instructions)
       values ($1, $2, 'Private', 'instructions', 'Secret style words.') returning id`,
      [admin.workspaceId, other.userId],
    );
    await h.ask(cookie, m, "Who is liable?", { writing_style_id: theirs.rows[0]?.id });
    expect(JSON.stringify(h.prompts().at(-1))).not.toContain("Secret style words.");
  });
});
