import { randomUUID } from "node:crypto";
import { createGateway, type Message } from "@legallabs/model-gateway";
import { createMemoryStore } from "@legallabs/storage";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
import { createDrafts } from "../drafts/drafts.js";
import { createRunLog } from "../runs/log.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { createVaults } from "../vaults/vaults.js";
import { createExports } from "./export.js";
import { createReviewTables } from "./module.js";

const pool = testPool();
afterAll(() => pool.end());

const CREDIT =
  "This Credit Agreement is dated 1 March 2024 between the Borrower and the Lenders. The aggregate commitments are USD 1.5 million. This Agreement is governed by the laws of the State of New York.";
const LEASE =
  "This Lease is dated 5 June 2023 between the Landlord and the Tenant. The annual rent is GBP 250,000 payable quarterly. This Lease is governed by the laws of England and Wales.";

const sentences = (text: string) => text.split(/(?<=\.)\s+/);

/**
 * Stands in for the model: answers from the passages it was shown, quoting the sentence that
 * holds the answer, the way a good model would. "Termination fee" is never in the documents.
 */
// What the Column Builder model proposes: 35 columns, one of them invalid, so the cap and the
// schema check both have something to do.
const PROPOSALS = JSON.stringify({
  columns: [
    { label: "Effective date", type: "date", prompt: "When is it dated?", options: {} },
    { label: "Commitments", type: "currency", prompt: "What are the commitments?", options: {} },
    {
      label: "Governing law",
      type: "classify",
      prompt: "Which law governs?",
      options: {
        options: [
          { id: "ny", label: "New York", color: "blue" },
          { id: "ew", label: "England and Wales", color: "purple" },
        ],
      },
    },
    { label: "Broken", type: "classify", prompt: "No options", options: { options: [] } },
    ...Array.from({ length: 31 }, (_, i) => ({
      label: `Term ${i + 1}`,
      type: "free",
      prompt: `What is term ${i + 1}?`,
      options: {},
    })),
  ],
});

function fakeModel(messages: readonly Message[]): string {
  if (messages[0]?.content.startsWith("You design review tables")) return PROPOSALS;
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const label = /Column: (.+)/.exec(user)?.[1] ?? "";
  const passages = [
    ...user.matchAll(/<passage-\w+ doc="(D\d+)" page="(\d+)">\n([\s\S]*?)\n<\/passage/g),
  ];
  const find = (pattern: RegExp) => {
    for (const [, doc, page, text] of passages) {
      for (const sentence of sentences(text ?? "")) {
        const match = pattern.exec(sentence);
        if (match) return { doc, page: Number(page), quote: sentence, value: match[1] ?? sentence };
      }
    }
    return null;
  };
  const hit =
    label === "Date"
      ? find(/dated (\d+ \w+ \d{4})/)
      : label === "Amount"
        ? find(/(?:commitments|rent) (?:are|is) ([A-Z]{3} [\d.,]+(?: million)?)/)
        : label === "Governing law"
          ? find(/laws of (?:the State of )?(New York|England and Wales)/)
          : null;
  if (!hit)
    return JSON.stringify({
      value: null,
      reasoning: "Not stated.",
      citations: [],
      not_found: true,
    });
  return JSON.stringify({
    value: hit.value,
    reasoning: "Stated in the document.",
    citations: [{ doc: hit.doc, page: hit.page, quote: hit.quote }],
    not_found: false,
  });
}

function harness(options: { asks?: number } = {}) {
  const store = createMemoryStore();
  const documents = testDocuments(pool, { store });
  const gateway = createGateway({
    providers: {
      ollama: {
        complete: async ({ messages }) => ({
          text: fakeModel(messages),
          usage: { input_tokens: 500, output_tokens: 40 },
        }),
      },
    },
    contextWindows: { ollama: 8_192 },
    recordUsage: async () => {},
  });
  const log = createRunLog(pool);
  const tables = createReviewTables(pool, { gateway, documents, log });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: {
      ...testThreads(pool, documents),
      log,
      ...(options.asks ? { asksPerWindow: options.asks } : {}),
    },
    drafts: createDrafts(pool, { gateway }),
    vaults: createVaults(pool, { documents, store }),
    tables,
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
  const raw = (cookie: string, method: string, path: string, json?: unknown) =>
    app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
  // biome-ignore lint/suspicious/noExplicitAny: test responses are read loosely
  const call = async (
    cookie: string,
    method: string,
    path: string,
    json?: unknown,
  ): Promise<{ status: number; body: any }> => {
    const res = await raw(cookie, method, path, json);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const vault = async (cookie: string, files: Record<string, string>) => {
    const created = await call(cookie, "POST", "/vaults", {
      name: `Deal ${randomUUID().slice(0, 4)}`,
    });
    const id = created.body.vault.id as string;
    const ids: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const form = new FormData();
      form.set("file", new File([content], name));
      const res = await app.request(`/api/v1/vaults/${id}/files`, {
        method: "POST",
        headers: { cookie },
        body: form,
      });
      ids.push(((await res.json()) as { file: { id: string } }).file.id);
    }
    return { id, ids };
  };
  return { app, call, raw, signIn, vault, tables, log };
}

async function colleague(m: Seeded, permissions = "{threads.use,tables.create}") {
  const email = `ben-${randomUUID().slice(0, 6)}@${m.slug}.test`;
  const role = await pool.query<{ id: string }>(
    "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
    [m.workspaceId, `User ${email}`, permissions],
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

const DATE = { label: "Date", type: "date", prompt: "When is the agreement dated?" };
const AMOUNT = {
  label: "Amount",
  type: "currency",
  prompt: "What is the main amount?",
  options: { decimals: 2 },
};
const LAW = {
  label: "Governing law",
  type: "classify",
  prompt: "Which law governs?",
  options: {
    options: [
      { id: "ny", label: "New York", color: "blue" },
      { id: "ew", label: "England and Wales", color: "purple" },
    ],
    allow_other: false,
  },
};
const FEE = { label: "Termination fee", type: "currency", prompt: "What is the termination fee?" };

async function setup(options: { asks?: number } = {}) {
  const h = harness(options);
  const m = await seedMember(pool);
  const cookie = await h.signIn(m);
  const v = await h.vault(cookie, { "credit.txt": CREDIT, "lease.txt": LEASE });
  const created = await h.call(cookie, "POST", "/review-tables", {
    name: "Deal review",
    source: { kind: "vault", vault_id: v.id, document_ids: v.ids },
  });
  expect(created.status).toBe(201);
  return { h, m, cookie, v, tableId: created.body.table.id as string };
}

const addColumn = async (s: Awaited<ReturnType<typeof setup>>, body: object) => {
  const res = await s.h.call(s.cookie, "POST", `/review-tables/${s.tableId}/columns`, body);
  expect(res.status).toBe(201);
  return res.body.column.id as string;
};

const runAndWait = async (
  s: Awaited<ReturnType<typeof setup>>,
  columnId: string,
  scope: unknown = "all",
) => {
  const res = await s.h.call(
    s.cookie,
    "POST",
    `/review-tables/${s.tableId}/columns/${columnId}/run`,
    { scope },
  );
  expect(res.status).toBe(202);
  await s.h.tables.runner.idle();
  return res.body;
};

const rows = async (s: Awaited<ReturnType<typeof setup>>, query = "") =>
  (await s.h.call(s.cookie, "GET", `/review-tables/${s.tableId}/rows?limit=200${query}`)).body;

describe("review tables API", () => {
  it("creates a table from a vault with one row per document (RVT-001)", async () => {
    const s = await setup();
    const got = await s.h.call(s.cookie, "GET", `/review-tables/${s.tableId}`);
    expect(got.body.table).toMatchObject({
      name: "Deal review",
      source_kind: "vault",
      vault_id: s.v.id,
    });
    expect(got.body.table.stats.rows).toBe(2);
    expect(got.body.columns).toEqual([]);
    const page = await rows(s);
    expect(
      page.rows.map((r: { documents: { name: string }[] }) => r.documents[0]?.name).sort(),
    ).toEqual(["credit.txt", "lease.txt"]);
    const trail = await auditTrail(pool, s.m.workspaceId);
    expect(trail.some((e) => e.action === "table.create" && e.details.rows === 2)).toBe(true);
  });

  it("refuses rows from another vault with SOURCE_MISMATCH (RVT-001)", async () => {
    const s = await setup();
    const other = await s.h.vault(s.cookie, { "other.txt": CREDIT });
    const res = await s.h.call(s.cookie, "POST", `/review-tables/${s.tableId}/rows`, {
      document_ids: other.ids,
    });
    expect(res).toMatchObject({ status: 400, body: { code: "SOURCE_MISMATCH" } });
  });

  it("refuses a source mixing uploads and vault files", async () => {
    const s = await setup();
    const res = await s.h.call(s.cookie, "POST", "/review-tables", {
      source: { kind: "uploads", upload_ids: s.v.ids },
    });
    expect(res).toMatchObject({ status: 400, body: { code: "SOURCE_MISMATCH" } });
  });

  it("refuses tables to a user without tables.create", async () => {
    const s = await setup();
    const ben = await colleague(s.m, "{threads.use}");
    const res = await s.h.call(await s.h.signIn(ben), "POST", "/review-tables", {
      source: { kind: "vault", vault_id: s.v.id },
    });
    expect(res.status).toBe(404); // he can't see the vault either
    expect(
      (await s.h.call(await s.h.signIn(ben), "GET", `/review-tables/${s.tableId}`)).status,
    ).toBe(404);
  });

  it("validates columns against their type", async () => {
    const s = await setup();
    const bad = await s.h.call(s.cookie, "POST", `/review-tables/${s.tableId}/columns`, {
      ...LAW,
      options: { options: [] },
    });
    expect(bad.status).toBe(400);
    const notMine = await s.h.call(s.cookie, "POST", `/review-tables/${s.tableId}/columns`, {
      ...DATE,
      model: "anthropic/claude-haiku-5-5",
    });
    expect(notMine).toMatchObject({ status: 403, body: { code: "MODEL_NOT_ALLOWED" } });
  });

  it("runs a column into typed, verified cells and streams progress (RVT-002, RVT-003)", async () => {
    const s = await setup();
    const amount = await addColumn(s, AMOUNT);
    const started = await runAndWait(s, amount);
    expect(started.cells).toBe(2);
    const page = await rows(s);
    const cells = page.cells.filter((c: { column_id: string }) => c.column_id === amount);
    expect(cells.map((c: { value_text: string }) => c.value_text).sort()).toEqual([
      "GBP 250,000.00",
      "USD 1,500,000.00",
    ]);
    for (const cell of cells) {
      expect(cell).toMatchObject({ status: "done", citation_count: 1, verified_citation_count: 1 });
      expect(cell.model).toBe("ollama/qwen3:4b-instruct");
      expect(cell.usage).toEqual({ input_tokens: 500, output_tokens: 40 });
      expect(cell.cost_usd).toBe(0);
    }
    const credit = cells.find(
      (c: { value_typed: { currency: string } }) => c.value_typed.currency === "USD",
    );
    expect(credit.value_typed).toEqual({ kind: "currency", amount: "1500000.00", currency: "USD" });

    const detail = await s.h.call(
      s.cookie,
      "GET",
      `/review-tables/${s.tableId}/cells/${credit.id}`,
    );
    expect(detail.body.citations[0]).toMatchObject({
      status: "ok",
      quote: "The aggregate commitments are USD 1.5 million.",
      document_name: "credit.txt",
    });
    expect(detail.body.citations[0].open_url).toMatch(/^\/d\//);

    const table = await s.h.call(s.cookie, "GET", `/review-tables/${s.tableId}`);
    expect(table.body.columns[0]).toMatchObject({
      id: amount,
      state: "done",
      progress: { done: 2, total: 2 },
    });
    expect(table.body.table.stats).toMatchObject({ cells_done: 2, valid_citation_rate: 1 });

    const events = await s.h.log.replay(s.m as never, started.run_id, 0);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "cell.updated")).toHaveLength(4);
    // The log is replayed without a wall check, so it carries no values.
    expect(JSON.stringify(events)).not.toContain("1,500,000");
    expect(events.some((e) => "value_text" in e)).toBe(false);
    expect(types).toContain("column.progress");
    expect(types.at(-1)).toBe("status");
    const run = await s.h.call(s.cookie, "GET", `/runs/${started.run_id}`);
    expect(run.body.run.status).toBe("done");
  });

  it("records what a null cell read (RVT-003)", async () => {
    const s = await setup();
    const fee = await addColumn(s, FEE);
    await runAndWait(s, fee);
    const cell = (await rows(s)).cells.find((c: { column_id: string }) => c.column_id === fee);
    expect(cell.status).toBe("null");
    expect(cell.looked_at.documents[0].pages).toEqual([1]);
    expect(cell.looked_at.queries.length).toBeGreaterThan(0);
  });

  it("never runs a manual column", async () => {
    const s = await setup();
    const notes = await addColumn(s, { label: "Notes", type: "manual", prompt: "" });
    const res = await s.h.call(
      s.cookie,
      "POST",
      `/review-tables/${s.tableId}/columns/${notes}/run`,
      {},
    );
    expect(res).toMatchObject({ status: 409, body: { code: "COLUMN_MANUAL" } });
  });

  it("edits, locks and skips locked cells (RVT-005)", async () => {
    const s = await setup();
    const date = await addColumn(s, DATE);
    await runAndWait(s, date);
    const [first] = (await rows(s)).cells;
    const path = `/review-tables/${s.tableId}/cells/${first.id}`;
    const edited = await s.h.call(s.cookie, "PATCH", path, { value_text: "2 March 2024" });
    expect(edited.body.cell).toMatchObject({ value_text: "2024-03-02", edited_by: s.m.userId });
    const detail = await s.h.call(s.cookie, "GET", path);
    expect(detail.body.history[0]).toMatchObject({
      field: "value",
      new: { value_text: "2024-03-02" },
    });
    expect(detail.body.citations[0].user_edited).toBe(true);

    await s.h.call(s.cookie, "PATCH", path, { locked: true });
    expect(await s.h.call(s.cookie, "PATCH", path, { value_text: "x" })).toMatchObject({
      status: 409,
      body: { code: "CELL_LOCKED" },
    });
    expect((await s.h.call(s.cookie, "POST", `${path}/rerun`, {})).body.code).toBe("CELL_LOCKED");
    const rerun = await runAndWait(s, date);
    expect(rerun).toMatchObject({ cells: 1, locked_skipped: 1 });
    const after = (await s.h.call(s.cookie, "GET", path)).body.cell;
    expect(after.value_text).toBe("2024-03-02");
  });

  it("skips verified cells on a column re-run unless asked", async () => {
    const s = await setup();
    const date = await addColumn(s, DATE);
    await runAndWait(s, date);
    const ids = (await rows(s)).cells.map((c: { id: string }) => c.id);
    const bulk = await s.h.call(s.cookie, "POST", `/review-tables/${s.tableId}/cells/bulk`, {
      cell_ids: ids,
      op: "verify",
    });
    expect(bulk.body.affected).toBe(2);
    expect(await runAndWait(s, date)).toMatchObject({
      cells: 0,
      verified_skipped: 2,
      run_id: null,
    });
    const again = await s.h.call(
      s.cookie,
      "POST",
      `/review-tables/${s.tableId}/columns/${date}/run`,
      {
        scope: "all",
        include_verified: true,
      },
    );
    expect(again.body.cells).toBe(2);
    await s.h.tables.runner.idle();
  });

  it("filters by flag and verification and sorts dates with nulls last (RVT-005)", async () => {
    const s = await setup();
    const date = await addColumn(s, DATE);
    await runAndWait(s, date);
    let page = await rows(s, `&sort=${date}:desc`);
    const first = page.rows[0].id;
    expect(page.rows[0].documents[0].name).toBe("credit.txt");
    const leaseCell = page.cells.find((c: { row_id: string }) => c.row_id !== first);
    await s.h.call(s.cookie, "PATCH", `/review-tables/${s.tableId}/cells/${leaseCell.id}`, {
      flag_color: "red",
    });
    page = await rows(s, `&sort=${date}:asc`);
    expect(page.rows[0].documents[0].name).toBe("lease.txt");
    const filter = encodeURIComponent(
      JSON.stringify({ conditions: [{ column_id: date, flag: ["red"], verified: false }] }),
    );
    page = await rows(s, `&filter=${filter}`);
    expect(page.rows.map((r: { documents: { name: string }[] }) => r.documents[0]?.name)).toEqual([
      "lease.txt",
    ]);
  });

  it("dry runs the first rows only and estimates first (RVT-010)", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    const files = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`doc-${String(i).padStart(2, "0")}.txt`, CREDIT]),
    );
    const v = await h.vault(cookie, files);
    const tableId = (
      await h.call(cookie, "POST", "/review-tables", { source: { kind: "vault", vault_id: v.id } })
    ).body.table.id;
    const s = { h, m, cookie, v, tableId };
    const date = await addColumn(s, DATE);
    const estimate = await h.call(cookie, "POST", `/review-tables/${tableId}/estimate`, {
      column_ids: [date],
      scope: "dry_run",
    });
    expect(estimate.body).toMatchObject({ cells: 10, est_cost_usd: 0 });
    expect(estimate.body.est_tokens).toBeGreaterThan(0);
    await runAndWait(s, date, "dry_run");
    const table = (await h.call(cookie, "GET", `/review-tables/${tableId}`)).body;
    expect(table.columns[0]).toMatchObject({
      state: "partial",
      dry_run: true,
      progress: { done: 10, total: 12 },
    });
    await runAndWait(s, date, "pending");
    expect(
      (await h.call(cookie, "GET", `/review-tables/${tableId}`)).body.columns[0].progress.done,
    ).toBe(12);
  }, 90_000);

  it("stars privately per user (RVT-010)", async () => {
    const s = await setup();
    expect((await s.h.call(s.cookie, "POST", `/review-tables/${s.tableId}/star`)).status).toBe(204);
    const starred = await s.h.call(s.cookie, "GET", "/review-tables?filter[starred]=true");
    expect(starred.body.items.map((t: { id: string }) => t.id)).toEqual([s.tableId]);
    const ben = await colleague(s.m);
    const his = await s.h.call(await s.h.signIn(ben), "GET", "/review-tables?filter[starred]=true");
    expect(his.body.items).toEqual([]);
  });

  it("cancels a run's queued cells", async () => {
    const s = await setup();
    const date = await addColumn(s, DATE);
    const res = await s.h.call(
      s.cookie,
      "POST",
      `/review-tables/${s.tableId}/columns/${date}/run`,
      {},
    );
    const cancel = await s.h.call(s.cookie, "POST", `/runs/${res.body.run_id}/cancel`);
    expect(cancel.status).toBe(202);
    await s.h.tables.runner.idle();
    const run = await s.h.call(s.cookie, "GET", `/runs/${res.body.run_id}`);
    expect(run.body.run.status).toBe("cancelled");
    const table = (await s.h.call(s.cookie, "GET", `/review-tables/${s.tableId}`)).body;
    expect(table.columns[0].state).toBe("stopped");
  });

  it("exports xlsx with fills and a citations sheet (RVT-008)", async () => {
    const s = await setup();
    const law = await addColumn(s, LAW);
    await runAndWait(s, law);
    const ids = (await rows(s)).cells.map((c: { id: string }) => c.id);
    await s.h.call(s.cookie, "POST", `/review-tables/${s.tableId}/cells/bulk`, {
      cell_ids: ids.slice(0, 1),
      op: "verify",
    });
    const res = await s.h.raw(s.cookie, "POST", `/review-tables/${s.tableId}/export`, {
      format: "xlsx",
      highlight_verified: true,
      classify_colors: true,
      include_citations: true,
    });
    expect(res.status).toBe(200);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"] as Uint8Array);
    expect(sheet).toContain("New York");
    expect(sheet).toContain("England and Wales");
    const styles = strFromU8(files["xl/styles.xml"] as Uint8Array);
    expect(styles).toContain("FFC6EFCE"); // verified green
    expect(styles).toMatch(/FFBDD7EE|FFD9C3E9/); // option colour
    expect(strFromU8(files["xl/worksheets/sheet2.xml"] as Uint8Array)).toContain(
      "governed by the laws",
    );

    const csv = await s.h.raw(s.cookie, "POST", `/review-tables/${s.tableId}/export`, {
      format: "csv",
    });
    expect(await csv.text()).toContain("Document,Governing law");
  });

  it("refuses export when the vault forbids downloads for the user (RVT-008)", async () => {
    const s = await setup();
    const ben = await colleague(s.m);
    await s.h.call(s.cookie, "PATCH", `/vaults/${s.v.id}`, {
      content_controls: { allow_download: false, allow_duplicate: true, show_review_prompts: true },
    });
    await s.h.call(s.cookie, "PUT", `/vaults/${s.v.id}/shares`, {
      grants: [{ principal_type: "user", principal_id: ben.userId, level: "view" }],
      workspace_view: false,
    });
    const benCookie = await s.h.signIn(ben);
    const his = await s.h.call(benCookie, "POST", "/review-tables", {
      source: { kind: "vault", vault_id: s.v.id },
    });
    expect(his.status).toBe(201);
    const res = await s.h.call(benCookie, "POST", `/review-tables/${his.body.table.id}/export`, {
      format: "csv",
    });
    expect(res).toMatchObject({ status: 403, body: { code: "EXPORT_DISABLED_BY_SOURCE" } });
  });

  it("proposes at most 30 schema-valid columns and spends an ask each time", async () => {
    const s = await setup({ asks: 2 });
    const generate = () =>
      s.h.call(s.cookie, "POST", `/review-tables/${s.tableId}/columns/generate`, {
        description: "lender-side credit agreement terms",
        max_columns: 30,
      });
    const res = await generate();
    expect(res.status).toBe(200);
    const proposals = res.body.proposals as { type: string; label: string }[];
    expect(proposals).toHaveLength(30);
    expect(proposals.map((p) => p.label)).not.toContain("Broken");
    expect(new Set(proposals.map((p) => p.type))).toEqual(
      new Set(["date", "currency", "classify", "free"]),
    );
    expect((await generate()).status).toBe(200);
    const limited = await generate();
    expect(limited).toMatchObject({ status: 429, body: { code: "TOO_MANY_REQUESTS" } });
  });

  it("answers 404, not 500, for ids that aren't ids", async () => {
    const s = await setup();
    const base = `/review-tables/${s.tableId}`;
    expect((await s.h.call(s.cookie, "DELETE", `${base}/columns/nope`)).status).toBe(404);
    expect((await s.h.call(s.cookie, "POST", "/runs/nope/cancel")).status).toBe(404);
    expect((await s.h.call(s.cookie, "GET", `${base}/cells/nope`)).status).toBe(404);
    expect((await s.h.call(s.cookie, "GET", "/review-tables/nope")).status).toBe(404);
  });

  it("records old and new in history for bulk, stale and cancel changes", async () => {
    const s = await setup();
    const date = await addColumn(s, DATE);
    await runAndWait(s, date);
    const [first, second] = (await rows(s)).cells;
    // A locked row takes no bulk verify, whatever its cells say.
    await pool.query("update work.rt_row set locked = true where id = $1", [second.row_id]);
    const bulk = await s.h.call(s.cookie, "POST", `/review-tables/${s.tableId}/cells/bulk`, {
      cell_ids: [first.id, second.id],
      op: "verify",
    });
    expect(bulk.body).toMatchObject({ affected: 1, skipped: 1 });
    const history = async (cellId: string) =>
      (await s.h.call(s.cookie, "GET", `/review-tables/${s.tableId}/cells/${cellId}`)).body.history;
    expect((await history(first.id))[0]).toMatchObject({
      field: "verified",
      old: false,
      new: true,
    });

    await s.h.call(s.cookie, "PATCH", `/review-tables/${s.tableId}`, { instructions: "Be brief." });
    expect((await history(first.id))[0]).toMatchObject({
      field: "status",
      old: "done",
      new: "stale",
    });

    const run = await s.h.call(
      s.cookie,
      "POST",
      `/review-tables/${s.tableId}/columns/${date}/run`,
      {
        scope: "all",
        include_verified: true,
      },
    );
    await s.h.call(s.cookie, "POST", `/runs/${run.body.run_id}/cancel`);
    await s.h.tables.runner.idle();
    const fields = (await history(first.id)).map((h: { field: string; new: unknown }) => h.field);
    expect(fields).toContain("status");
  });

  it("audits a bulk rerun as a cell rerun", async () => {
    const s = await setup();
    const date = await addColumn(s, DATE);
    await runAndWait(s, date);
    const ids = (await rows(s)).cells.map((c: { id: string }) => c.id);
    const res = await s.h.call(s.cookie, "POST", `/review-tables/${s.tableId}/cells/bulk`, {
      cell_ids: ids,
      op: "rerun",
    });
    expect(res.body.run_ids).toHaveLength(1);
    await s.h.tables.runner.idle();
    const trail = await auditTrail(pool, s.m.workspaceId);
    expect(trail.some((e) => e.action === "table.cell.rerun" && e.details.cells === 2)).toBe(true);
  });

  it("dry runs the first rows of the view the user sees (RVT-010)", async () => {
    const s = await setup();
    const date = await addColumn(s, DATE);
    const amount = await addColumn(s, AMOUNT);
    await runAndWait(s, date);
    // Filtered to the 2023 lease, a dry run must leave the credit agreement alone.
    const res = await s.h.call(
      s.cookie,
      "POST",
      `/review-tables/${s.tableId}/columns/${amount}/run`,
      {
        scope: "dry_run",
        sort: { column_id: date, direction: "asc" },
        filter: { conditions: [{ column_id: date, contains: "2023" }] },
      },
    );
    expect(res.body.cells).toBe(1);
    await s.h.tables.runner.idle();
    const page = await rows(s);
    const status = (name: string) => {
      const row = page.rows.find(
        (r: { documents: { name: string }[] }) => r.documents[0]?.name === name,
      );
      return page.cells.find(
        (c: { row_id: string; column_id: string }) => c.row_id === row.id && c.column_id === amount,
      )?.status;
    };
    expect(status("lease.txt")).toBe("done");
    expect(status("credit.txt")).toBe("pending");
  });

  it("refuses a synchronous export over the cell limit with EXPORT_TOO_LARGE (RVT-008)", async () => {
    const s = await setup();
    await addColumn(s, DATE);
    const principal = { sessionId: "test", userId: s.m.userId, workspaceId: s.m.workspaceId };
    const client = { ip: null, userAgent: null };
    const small = createExports(pool, { maxCells: 1 });
    expect(await small.run(principal, s.tableId, { format: "csv" } as never, client)).toMatchObject(
      {
        ok: false,
        code: "EXPORT_TOO_LARGE",
        details: { limit: 1 },
      },
    );
    expect(
      (await createExports(pool).run(principal, s.tableId, { format: "csv" } as never, client)).ok,
    ).toBe(true);
  });
});
