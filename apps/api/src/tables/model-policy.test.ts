import { createGateway } from "@legallabs/model-gateway";
import { createMemoryStore } from "@legallabs/storage";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { createDrafts } from "../drafts/drafts.js";
import { createRunLog } from "../runs/log.js";
import { PASSWORD, seedMember, testDocuments, testPool, testThreads } from "../test-db.js";
import { countingProviders, denyProviders, fileInMatter, newMatter } from "../test-model-policy.js";
import { CREDIT, fakeModel } from "../test-tables.js";
import { createReviewTables } from "./module.js";

const pool = testPool();
afterAll(() => pool.end());

const DATE = { label: "Date", type: "free", prompt: "When is it dated?", options: {} };

async function setup(hold: () => Promise<void> | undefined = () => undefined) {
  const model = countingProviders((_, all) =>
    fakeModel([
      { role: "system", content: all.split("\n")[0] ?? "" },
      { role: "user", content: all },
    ]),
  );
  const documents = testDocuments(pool, { store: createMemoryStore() });
  const gateway = createGateway({
    providers: model.providers,
    contextWindows: { ollama: 8_192 },
    recordUsage: async () => {},
  });
  const tables = createReviewTables(pool, {
    gateway: {
      ...gateway,
      call: async (request, signal) => {
        await hold();
        return gateway.call(request, signal);
      },
    },
    documents,
    log: createRunLog(pool),
    dependencyPollMs: 20,
  });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: testThreads(pool, documents),
    drafts: createDrafts(pool, { gateway }),
    tables,
    clientIp: () => "203.0.113.9",
  });
  const m = await seedMember(pool);
  const login = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: test responses are read loosely
    return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
  };
  const uploaded = await documents.upload(
    { sessionId: "s", userId: m.userId, workspaceId: m.workspaceId },
    { name: "credit.txt", bytes: new TextEncoder().encode(CREDIT), matterId: null },
    { ip: null, userAgent: null },
  );
  if (!uploaded.ok) throw new Error(uploaded.reason);
  await documents.worker.drain(m.workspaceId);
  const matterId = await newMatter(pool, m);
  await fileInMatter(pool, uploaded.document.versionId, matterId);
  const made = await call("POST", "/review-tables", {
    source: { kind: "uploads", upload_ids: [uploaded.document.id] },
  });
  const tableId = made.body.table.id as string;
  const column = async (extra: object = {}) =>
    (await call("POST", `/review-tables/${tableId}/columns`, { ...DATE, ...extra })).body.column
      .id as string;
  const run = (columnId: string) =>
    call("POST", `/review-tables/${tableId}/columns/${columnId}/run`, {
      scope: "all",
      include_verified: true,
    });
  const cells = async () =>
    (
      await pool.query<{ status: string; error_code: string | null }>(
        "select status, error_code from work.rt_cell where table_id = $1",
        [tableId],
      )
    ).rows;
  const seal = (...providers: string[]) => denyProviders(pool, matterId, ...providers);
  const generate = () =>
    call("POST", `/review-tables/${tableId}/columns/generate`, {
      description: "Key dates",
      max_columns: 3,
    });
  return { calls: model.calls, tables, call, tableId, column, run, cells, seal, generate };
}

const refused = { status: 403, body: { code: "MODEL_NOT_ALLOWED" } };
const none = { anthropic: 0, ollama: 0 };

describe("a matter's model policy in review tables", () => {
  it("refuses column generation when no model is left", async () => {
    const s = await setup();
    await s.seal("anthropic", "ollama");
    expect(await s.generate()).toMatchObject(refused);
    expect(s.calls).toEqual(none);
  });

  it("leaves a denied provider out of column generation and cells", async () => {
    const s = await setup();
    await s.seal("anthropic");
    expect((await s.generate()).status).toBe(200);
    const id = await s.column();
    await s.tables.runner.idle();
    await s.run(id);
    await s.tables.runner.idle();
    expect(s.calls.anthropic).toBe(0);
    expect(s.calls.ollama).toBeGreaterThan(1);
  });

  it("refuses to run a column when no model, or not its own model, is left", async () => {
    const s = await setup();
    await s.seal("anthropic", "ollama");
    const any = await s.column();
    expect(await s.run(any)).toMatchObject(refused);
    expect(await s.call("POST", `/review-tables/${s.tableId}/run`, {})).toMatchObject(refused);
    await s.seal("anthropic");
    const pinned = await s.column({ label: "Pinned", model: "anthropic/claude-haiku-5-5" });
    await s.tables.runner.idle();
    expect(await s.run(pinned)).toMatchObject(refused);
    expect(s.calls.anthropic).toBe(0);
  });

  it("applies a policy set after the cells were queued", async () => {
    let release = () => {};
    let held: (() => Promise<void>) | undefined;
    const s = await setup(() => held?.());
    const date = await s.column();
    await s.tables.runner.idle();
    const after = await s.column({ label: "After", prompt: `What follows @{${date}}?` });
    await s.tables.runner.idle();
    let reached = () => {};
    const sent = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    held = () => {
      reached();
      return gate;
    };
    const before = s.calls.ollama + s.calls.anthropic;
    const started = await s.call("POST", `/review-tables/${s.tableId}/columns/${date}/run`, {
      scope: "all",
      include_verified: true,
      include_dependents: true,
    });
    expect(started.status).toBe(202);
    await sent;
    await s.seal("anthropic", "ollama");
    release();
    await s.tables.runner.idle();
    // The first cell was on its way already; the one waiting on it is never sent.
    expect(s.calls.ollama + s.calls.anthropic - before).toBeLessThanOrEqual(1);
    const { rows } = await pool.query<{ status: string; error_code: string | null }>(
      "select status, error_code from work.rt_cell where column_id = $1",
      [after],
    );
    expect(rows).toEqual([{ status: "error", error_code: "MODEL_ERROR" }]);
  });
});
