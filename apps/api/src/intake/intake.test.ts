import { randomUUID } from "node:crypto";
import { createStubScanner } from "@legallabs/ingest";
import { createGateway } from "@legallabs/model-gateway";
import type pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
import { asApp } from "../db.js";
import { createDocuments } from "../documents/documents.js";
import { createDrafts } from "../drafts/drafts.js";
import { createHub } from "../notifications/hub.js";
import { createNotifications } from "../notifications/notifications.js";
import { createNotifier } from "../notifications/notify.js";
import { createRunLog } from "../runs/log.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
} from "../test-db.js";
import { noKnowledge, noVaults } from "../threads/ports.js";
import { createThreads } from "../threads/threads.js";
import { createVaults } from "../vaults/vaults.js";
import { createIntake, type IntakeOptions } from "./intake.js";

const pool = testPool();
afterAll(() => pool.end());

// biome-ignore lint/suspicious/noExplicitAny: test responses are checked field by field.
type Json = any;
type Person = Seeded & { cookie: string };

/**
 * The same pool, but audit writes whose SQL contains `broken` fail in the database, aborting the
 * transaction as a real failure would. Done here rather than with a trigger: tests in other files
 * share the database.
 */
function flakyPool(broken: () => string | null): pg.Pool {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        query(sql: string, params?: unknown[]) {
          const word = broken();
          const fail = word !== null && sql.includes("append_audit_event") && sql.includes(word);
          return fail ? client.query("select 1 / 0") : client.query(sql, params);
        },
        release: (err?: Error | boolean) => client.release(err),
      };
    },
  } as unknown as pg.Pool;
}

function harness(options: Partial<IntakeOptions> = {}) {
  const audit: { broken: string | null } = { broken: null };
  const flaky = flakyPool(() => audit.broken);
  const documents = testDocuments(pool, { scanner: createStubScanner() });
  const vaults = createVaults(pool, { documents, store: documents.store });
  // The raw service: ingest is left to each test, as in the running server.
  const intake = createIntake(flaky, {
    documents: createDocuments(flaky, { store: documents.store }),
    notifier: createNotifier(pool, createHub()),
    ...options,
  });
  const gateway = createGateway({ providers: {}, recordUsage: async () => {} });
  const log = createRunLog(pool);
  const threads = createThreads(pool, {
    gateway,
    documents,
    log,
    vaults: noVaults,
    knowledge: noKnowledge,
  });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    vaults,
    threads: { gateway, log, vaults: noVaults, knowledge: noKnowledge, threads },
    notifications: createNotifications(pool),
    drafts: createDrafts(pool, { gateway }),
    intake,
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
  const read = async (res: Response) => {
    const text = await res.text();
    let body: Json = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };
  const call = async (who: Person, method: string, path: string, json?: unknown) =>
    read(
      await app.request(`/api/v1${path}`, {
        method,
        headers: {
          cookie: who.cookie,
          ...(json === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      }),
    );
  const upload = async (who: Person, name = "draft.txt", content = "Mutual NDA with Acme.") => {
    const form = new FormData();
    form.set("file", new File([content], name));
    return read(
      await app.request("/api/v1/apps/intake/attachments", {
        method: "POST",
        headers: { cookie: who.cookie },
        body: form,
      }),
    );
  };

  const workspace = async (): Promise<Person> => {
    const m = await seedMember(pool);
    return { ...m, cookie: await signIn(m) };
  };
  const member = async (ws: Person, permissions: string[]): Promise<Person> => {
    const email = `u-${randomUUID().slice(0, 8)}@${ws.slug}.test`;
    const role = await pool.query<{ id: string }>(
      "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
      [ws.workspaceId, email, permissions],
    );
    const user = await pool.query<{ id: string }>(
      `insert into core."user" (workspace_id, email, role_id, status)
       values ($1, $2, $3, 'active') returning id`,
      [ws.workspaceId, email, role.rows[0]?.id],
    );
    const userId = user.rows[0]?.id ?? "";
    await pool.query(
      "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
      [ws.workspaceId, userId, await hashPassword(PASSWORD)],
    );
    const m = { slug: ws.slug, email, userId, workspaceId: ws.workspaceId };
    return { ...m, cookie: await signIn(m) };
  };
  const triager = (ws: Person) => member(ws, ["intake.triage", "threads.use"]);

  /** A matter everyone may open except the people named. */
  const matter = async (ws: Person, walled: Person[] = []) => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name, wall_mode)
       values ($1, 'C', 'Client', $2, 'Falcon', 'open') returning id`,
      [ws.workspaceId, randomUUID().slice(0, 8)],
    );
    const id = rows[0]?.id ?? "";
    for (const who of walled) await wall(ws, id, who);
    return id;
  };
  const wall = (ws: Person, matterId: string, who: Person) =>
    pool.query(
      `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
       values ($1, $2, 'user', $3, 'deny')`,
      [ws.workspaceId, matterId, who.userId],
    );

  const nda = async (ws: Person, over: Record<string, unknown> = {}) => {
    const res = await call(ws, "POST", "/apps/intake/request-types", {
      name: `NDA ${randomUUID().slice(0, 6)}`,
      fields: [
        { key: "counterparty", label: "Counterparty", type: "text", required: true },
        { key: "mutual", label: "Mutual?", type: "boolean", required: true },
      ],
      sla_hours: 8,
      ...over,
    });
    expect(res.status).toBe(201);
    return res.body.type as Json;
  };
  const ask = async (who: Person, body: Record<string, unknown> = {}) =>
    call(who, "POST", "/apps/intake/requests", {
      requester: { display_name: "Jo Smith", email: "jo@acme.example" },
      ...body,
    });
  const made = async (who: Person, body: Record<string, unknown> = {}) => {
    const res = await ask(who, body);
    expect(res.status).toBe(201);
    return res.body.request as Json;
  };

  return {
    app,
    audit,
    call,
    upload,
    workspace,
    member,
    triager,
    matter,
    wall,
    nda,
    ask,
    made,
    documents,
  };
}

const actions = async (ws: Person) =>
  (await auditTrail(pool, ws.workspaceId)).filter((e) => e.action.startsWith("intake."));

describe("request types", () => {
  it("are created, changed and removed by managers, and audited", async () => {
    const h = harness();
    const admin = await h.workspace();
    const manager = await h.member(admin, ["intake.manage"]);
    const triage = await h.triager(admin);
    const type = await h.nda(manager, { name: "NDA" });
    expect(type).toMatchObject({ name: "NDA", sla_hours: 8, routing: null });

    const path = `/apps/intake/request-types/${type.id}`;
    const patched = await h.call(manager, "PATCH", path, { sla_hours: 24 });
    expect(patched.body.type).toMatchObject({ name: "NDA", sla_hours: 24 });
    expect((await h.call(triage, "GET", "/apps/intake/request-types")).body).toMatchObject({
      types: [{ id: type.id }],
      can_manage: false,
    });
    expect((await h.call(manager, "GET", "/apps/intake/request-types")).body.can_manage).toBe(true);
    const clash = await h.call(manager, "POST", "/apps/intake/request-types", {
      name: "nda",
      fields: [],
      sla_hours: 1,
    });
    expect([clash.status, clash.body.code]).toEqual([409, "NAME_TAKEN"]);

    expect((await h.call(manager, "DELETE", path)).status).toBe(204);
    expect((await h.call(manager, "PATCH", path, { sla_hours: 2 })).status).toBe(404);
    expect((await h.call(manager, "GET", "/apps/intake/request-types")).body.types).toEqual([]);
    expect((await actions(admin)).map((a) => a.action)).toEqual([
      "intake.type.created",
      "intake.type.updated",
      "intake.type.deleted",
    ]);
  });

  it("are closed to people without the permissions", async () => {
    const h = harness();
    const admin = await h.workspace();
    const triage = await h.triager(admin);
    const nobody = await h.member(admin, ["threads.use"]);
    const type = await h.nda(admin);
    const body = { name: "x", fields: [], sla_hours: 1 };
    for (const [who, method, path] of [
      [triage, "POST", "/apps/intake/request-types"],
      [triage, "PATCH", `/apps/intake/request-types/${type.id}`],
      [triage, "DELETE", `/apps/intake/request-types/${type.id}`],
      [nobody, "GET", "/apps/intake/request-types"],
      [nobody, "POST", "/apps/intake/request-types"],
    ] as const) {
      const res = await h.call(
        who,
        method,
        path,
        method === "DELETE" || method === "GET" ? undefined : body,
      );
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
    }
  });

  it("refuse a routing target the manager can't open, and unknown people", async () => {
    const h = harness();
    const admin = await h.workspace();
    const body = (extra: object) => ({ name: randomUUID(), fields: [], sla_hours: 1, ...extra });
    for (const routing of [
      {
        kind: "agent",
        agent_id: "0190a6c2-0000-7000-8000-000000000001",
        post_results_to_requester: false,
      },
      { kind: "contract_intelligence", ci_agent_id: "0190a6c2-0000-7000-8000-000000000001" },
      { kind: "lawyer", space_id: "0190a6c2-0000-7000-8000-000000000001", assignment: [] },
    ]) {
      const res = await h.call(admin, "POST", "/apps/intake/request-types", body({ routing }));
      expect([res.status, res.body.code]).toEqual([422, "ROUTE_NOT_ACCESSIBLE"]);
    }
    const other = await h.workspace();
    for (const extra of [
      { default_owners: [other.userId] },
      { reviewers: ["0190a6c2-0000-7000-8000-000000000001"] },
      {
        escalations: [
          { when: [{ sla: "breached" }], action: "notify", target: { user_id: other.userId } },
        ],
      },
    ]) {
      const res = await h.call(admin, "POST", "/apps/intake/request-types", body(extra));
      expect([res.status, res.body.code]).toEqual([422, "UNKNOWN_PRINCIPAL"]);
    }
  });
});

describe("creating a request", () => {
  it("numbers it, records the requester and says what is missing", async () => {
    const h = harness();
    const admin = await h.workspace();
    const triage = await h.triager(admin);
    const type = await h.nda(admin);
    const request = await h.made(triage, { type_id: type.id, fields: { counterparty: "Acme" } });
    expect(request).toMatchObject({
      number: 1,
      channel: "api",
      status: "new",
      type_id: type.id,
      type_name: type.name,
      missing_fields: ["mutual"],
      requester: { display_name: "Jo Smith", email: "jo@acme.example" },
      assignee_id: null,
      sla: { state: "ok" },
      attachments: [],
    });
    const untyped = await h.made(triage);
    expect(untyped).toMatchObject({ number: 2, status: "unclassified", sla: null });

    const trail = await actions(admin);
    const created = trail.find(
      (e) => e.action === "intake.request.created" && e.object_id === request.id,
    );
    expect(created).toMatchObject({ actor_id: triage.userId, object_type: "intake_request" });
    // Ids and counts only: nothing the requester sent.
    expect(JSON.stringify(trail)).not.toMatch(/Jo Smith|acme\.example|Acme/);

    // A requester is not a user and gets no account.
    const users = await pool.query(
      `select 1 from core."user" where workspace_id = $1 and email = 'jo@acme.example'`,
      [admin.workspaceId],
    );
    expect(users.rowCount).toBe(0);
  });

  it("numbers requests made at the same moment without gaps or repeats", async () => {
    const h = harness();
    const admin = await h.workspace();
    const made = await Promise.all(Array.from({ length: 12 }, () => h.made(admin)));
    expect(made.map((r) => r.number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    const other = await h.workspace();
    expect((await h.made(other)).number).toBe(1);
  });

  it("refuses bad values, an unknown type and a repeated reference, and audits the refusal", async () => {
    const h = harness();
    const admin = await h.workspace();
    const type = await h.nda(admin);
    const bad = await h.ask(admin, { type_id: type.id, fields: { mutual: "yes", extra: "x" } });
    expect([bad.status, bad.body.code]).toEqual([422, "INVALID_FIELDS"]);
    expect(bad.body.details.sort()).toEqual(["extra", "mutual"]);
    const unknown = await h.ask(admin, { type_id: "0190a6c2-0000-7000-8000-000000000001" });
    expect([unknown.status, unknown.body.code]).toEqual([422, "TYPE_NOT_FOUND"]);
    await h.made(admin, { external_ref: "ticket-1" });
    const again = await h.ask(admin, { external_ref: "ticket-1" });
    expect([again.status, again.body.code]).toEqual([409, "DUPLICATE"]);

    const refused = (await actions(admin)).filter((e) => e.action === "intake.request.refused");
    expect(refused.map((e) => e.details)).toEqual([
      { reason: "INVALID_FIELDS" },
      { reason: "TYPE_NOT_FOUND" },
      { reason: "DUPLICATE" },
    ]);
    // A refused request leaves nothing behind, not even its number.
    expect((await h.made(admin)).number).toBe(2);
  });

  it("is only for triage staff", async () => {
    const h = harness();
    const admin = await h.workspace();
    const manager = await h.member(admin, ["intake.manage", "threads.use"]);
    const nobody = await h.member(admin, ["threads.use"]);
    for (const who of [manager, nobody]) {
      expect((await h.ask(who)).status).toBe(403);
      expect((await h.upload(who)).status).toBe(403);
    }
  });
});

describe("the queue", () => {
  it("answers 403 without intake.triage on every request endpoint", async () => {
    const h = harness();
    const admin = await h.workspace();
    const nobody = await h.member(admin, ["intake.manage", "threads.use"]);
    const { id } = await h.made(admin);
    for (const [method, path, body] of [
      ["GET", "/apps/intake/requests", undefined],
      ["GET", `/apps/intake/requests/${id}`, undefined],
      ["GET", `/apps/intake/requests/${id}/audit`, undefined],
      ["GET", `/apps/intake/requests/${id}/assignees`, undefined],
      ["POST", `/apps/intake/requests/${id}/assign`, { assignee_id: nobody.userId }],
      ["POST", `/apps/intake/requests/${id}/status`, { status: "closed", reason: "x" }],
      ["POST", `/apps/intake/requests/${id}/type`, { type_id: id }],
    ] as const) {
      const res = await h.call(nobody, method, path, body);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });

  it("filters, sorts and pages", async () => {
    const h = harness({ pageSize: 2 });
    const admin = await h.workspace();
    const type = await h.nda(admin);
    const one = await h.made(admin, { type_id: type.id });
    const two = await h.made(admin);
    const three = await h.made(admin);
    await h.call(admin, "POST", `/apps/intake/requests/${two.id}/status`, {
      status: "closed",
      reason: "spam",
    });
    await h.call(admin, "POST", `/apps/intake/requests/${three.id}/assign`, {
      assignee_id: admin.userId,
    });
    const numbers = async (query: string) => {
      const res = await h.call(admin, "GET", `/apps/intake/requests${query}`);
      expect(res.status).toBe(200);
      return res.body.requests.map((r: Json) => r.number);
    };
    const first = await h.call(admin, "GET", "/apps/intake/requests");
    expect(first.body.requests.map((r: Json) => r.number)).toEqual([3, 2]);
    expect(await numbers(`?cursor=${first.body.next_cursor}`)).toEqual([1]);
    expect(await numbers("?sort=created_at")).toEqual([1, 2]);
    expect(await numbers("?filter%5Bstatus%5D=open")).toEqual([3, 1]);
    expect(await numbers("?filter%5Bstatus%5D=closed")).toEqual([2]);
    expect(await numbers("?filter%5Bassignee_id%5D=me")).toEqual([3]);
    expect(await numbers(`?filter%5Btype_id%5D=${type.id}`)).toEqual([one.number]);
    expect(await numbers("?filter%5Bchannel%5D=email")).toEqual([]);
    expect((await h.call(admin, "GET", "/apps/intake/requests?cursor=abc")).status).toBe(400);
  });

  it("shows nothing of another workspace", async () => {
    const h = harness();
    const admin = await h.workspace();
    const other = await h.workspace();
    const { id } = await h.made(admin);
    expect((await h.call(other, "GET", `/apps/intake/requests/${id}`)).status).toBe(404);
    expect((await h.call(other, "GET", `/apps/intake/requests/${id}/audit`)).status).toBe(404);
    expect((await h.call(other, "GET", "/apps/intake/requests")).body.requests).toEqual([]);
  });
});

describe("assignment, type and status", () => {
  it("moves a request along and keeps its timeline", async () => {
    const h = harness();
    const admin = await h.workspace();
    const triage = await h.triager(admin);
    const type = await h.nda(admin);
    const { id, number } = await h.made(admin);
    const base = `/apps/intake/requests/${id}`;

    const early = await h.call(admin, "POST", `${base}/status`, { status: "triaged" });
    expect([early.status, early.body.code]).toEqual([409, "TYPE_REQUIRED"]);
    const typed = await h.call(admin, "POST", `${base}/type`, { type_id: type.id });
    expect(typed.body.request).toMatchObject({
      status: "new",
      type_id: type.id,
      missing_fields: ["counterparty", "mutual"],
      sla: { state: "ok" },
    });
    const given = await h.call(admin, "POST", `${base}/assign`, { assignee_id: triage.userId });
    expect(given.body.request).toMatchObject({ assignee_id: triage.userId });
    for (const status of ["triaged", "in_progress", "done"]) {
      const res = await h.call(triage, "POST", `${base}/status`, { status });
      expect(res.body.request.status).toBe(status);
    }
    for (const [path, body] of [
      ["status", { status: "closed", reason: "x" }],
      ["assign", { assignee_id: admin.userId }],
      ["type", { type_id: type.id }],
    ] as const) {
      const res = await h.call(admin, "POST", `${base}/${path}`, body);
      expect([res.status, res.body.code]).toEqual([409, "WRONG_STATE"]);
    }

    const { events } = (await h.call(admin, "GET", `${base}/audit`)).body;
    expect(events.map((e: Json) => [e.kind, e.actor_id])).toEqual([
      ["inbound", admin.userId],
      ["classified", admin.userId],
      ["assigned", admin.userId],
      ["status", triage.userId],
      ["status", triage.userId],
      ["status", triage.userId],
    ]);
    expect(events.every((e: Json) => e.at && e.actor_name)).toBe(true);
    expect(events[5].details).toEqual({ from: "in_progress", to: "done" });

    const told = await h.call(triage, "GET", "/notifications");
    expect(told.body.items).toMatchObject([{ kind: "intake.request_assigned", available: true }]);
    expect(told.body.items[0].title).toContain(`#${number}`);
    expect(JSON.stringify(told.body.items[0])).toContain(`#/intake/requests/${id}`);

    expect((await actions(admin)).map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "intake.request.classified",
        "intake.request.assigned",
        "intake.request.status_changed",
      ]),
    );
    const outcomes = await pool.query(
      "select 1 from analytics.outcome_event where workspace_id = $1 and workflow_type = 'request_resolved'",
      [admin.workspaceId],
    );
    expect(outcomes.rowCount).toBe(1);
  });

  it("gives a request only to triage staff who can open it", async () => {
    const h = harness();
    const admin = await h.workspace();
    const walled = await h.triager(admin);
    const nobody = await h.member(admin, ["threads.use"]);
    const other = await h.workspace();
    const matter = await h.matter(admin, [walled]);
    const { id } = await h.made(admin, { matter_id: matter });
    for (const person of [walled, nobody, other]) {
      const res = await h.call(admin, "POST", `/apps/intake/requests/${id}/assign`, {
        assignee_id: person.userId,
      });
      expect([res.status, res.body.code]).toEqual([422, "ASSIGNEE_NOT_ALLOWED"]);
    }
    const list = await h.call(admin, "GET", `/apps/intake/requests/${id}/assignees`);
    expect(list.body.people.map((p: Json) => p.id)).toEqual([admin.userId]);
    const refused = (await actions(admin)).filter((e) => e.action === "intake.request.refused");
    expect(refused.map((e) => [e.object_id, e.details.reason])).toEqual(
      Array.from({ length: 3 }, () => [id, "ASSIGNEE_NOT_ALLOWED"]),
    );
  });

  it("refuses a move the status rules don't allow", async () => {
    const h = harness();
    const admin = await h.workspace();
    const { id } = await h.made(admin);
    const res = await h.call(admin, "POST", `/apps/intake/requests/${id}/status`, {
      status: "done",
    });
    expect([res.status, res.body.code]).toEqual([409, "WRONG_STATE"]);
  });

  it("leaves nothing changed when the audit trail can't be written", async () => {
    const h = harness();
    const admin = await h.workspace();
    const { id } = await h.made(admin);
    h.audit.broken = "append_audit_event";
    const assigned = await h.call(admin, "POST", `/apps/intake/requests/${id}/assign`, {
      assignee_id: admin.userId,
    });
    expect(assigned.status).toBe(500);
    expect((await h.ask(admin)).status).toBe(500);
    h.audit.broken = null;
    const queue = await h.call(admin, "GET", "/apps/intake/requests");
    expect(queue.body.requests).toMatchObject([{ id, assignee_id: null }]);
  });
});

describe("walls", () => {
  it("hides a matter's request, its files and its timeline from walled staff", async () => {
    const h = harness();
    const admin = await h.workspace();
    const walled = await h.triager(admin);
    const matter = await h.matter(admin, [walled]);
    const file = (await h.upload(admin, "falcon.txt")).body.attachment;
    const request = await h.made(admin, { matter_id: matter, attachments: [file.document_id] });
    await h.documents.worker.drain(admin.workspaceId);
    const base = `/apps/intake/requests/${request.id}`;

    expect((await h.call(admin, "GET", base)).body.request.attachments).toMatchObject([
      { document_id: file.document_id, name: "falcon.txt", state: "indexed" },
    ]);
    for (const path of [base, `${base}/audit`, `${base}/assignees`]) {
      expect((await h.call(walled, "GET", path)).status).toBe(404);
    }
    expect(
      (await h.call(walled, "POST", `${base}/status`, { status: "closed", reason: "x" })).status,
    ).toBe(404);
    expect((await h.call(walled, "GET", "/apps/intake/requests")).body.requests).toEqual([]);
    expect((await h.call(walled, "GET", `/documents/${file.document_id}`)).status).toBe(404);
    const found = await h.call(walled, "GET", "/documents/search?q=Mutual");
    expect(found.body.passages).toEqual([]);
    const inbox = await inboxOf(admin);
    const tree = await h.call(walled, "GET", `/vaults/${inbox.vault_id}/tree`);
    expect(JSON.stringify(tree.body)).not.toContain("falcon");

    // A wall raised afterwards takes effect at once.
    await h.wall(admin, matter, admin);
    expect((await h.call(admin, "GET", base)).status).toBe(404);
    expect((await h.call(admin, "GET", `/documents/${file.document_id}`)).status).toBe(404);
  });

  it("refuses a matter the person can't open, also through a matter field", async () => {
    const h = harness();
    const admin = await h.workspace();
    const walled = await h.triager(admin);
    const matter = await h.matter(admin, [walled]);
    const type = await h.nda(admin, {
      fields: [{ key: "matter", label: "Matter", type: "matter", required: false }],
    });
    for (const body of [{ matter_id: matter }, { type_id: type.id, fields: { matter } }]) {
      const res = await h.ask(walled, body);
      expect([res.status, res.body.code]).toEqual([422, "MATTER_NOT_FOUND"]);
    }
    const request = await h.made(admin, { type_id: type.id, fields: { matter } });
    expect(request.matter_id).toBe(matter);
    const other = await h.matter(admin);
    const mixed = await h.ask(admin, { type_id: type.id, matter_id: other, fields: { matter } });
    expect([mixed.status, mixed.body.code]).toEqual([422, "INVALID_FIELDS"]);
  });

  it("never lets a matter in by changing the type", async () => {
    const h = harness();
    const admin = await h.workspace();
    const matter = await h.matter(admin);
    const type = await h.nda(admin, {
      fields: [{ key: "matter", label: "Matter", type: "matter", required: true }],
    });
    // Free text while untyped; the type change must not turn it into the request's matter.
    const request = await h.made(admin, { fields: { matter } });
    const typed = await h.call(admin, "POST", `/apps/intake/requests/${request.id}/type`, {
      type_id: type.id,
    });
    expect(typed.body.request).toMatchObject({ matter_id: null, missing_fields: ["matter"] });
  });
});

const inboxOf = async (ws: Person) =>
  (
    await pool.query<{ vault_id: string; service_user_id: string }>(
      "select vault_id, service_user_id from apps.intake_inbox where workspace_id = $1",
      [ws.workspaceId],
    )
  ).rows[0] as { vault_id: string; service_user_id: string };

describe("attachments and the Inbox", () => {
  it("files them under the service user, scanned and read only by triage staff", async () => {
    const h = harness();
    const admin = await h.workspace();
    const triage = await h.triager(admin);
    const nobody = await h.member(admin, ["threads.use"]);
    const res = await h.upload(triage, "nda.txt");
    expect(res.status).toBe(201);
    const file = res.body.attachment;
    expect(file).toMatchObject({ name: "nda.txt", state: "queued" });

    const inbox = await inboxOf(admin);
    const owner = await pool.query(
      "select owner_id, vault_id from content.document where id = $1",
      [file.document_id],
    );
    expect(owner.rows[0]).toEqual({ owner_id: inbox.service_user_id, vault_id: inbox.vault_id });

    // Not yet attached: only the person adding it.
    expect((await h.call(admin, "GET", `/documents/${file.document_id}`)).status).toBe(404);
    const theirs = await h.ask(admin, { attachments: [file.document_id] });
    expect([theirs.status, theirs.body.code]).toEqual([422, "ATTACHMENT_NOT_FOUND"]);

    const request = await h.made(triage, { attachments: [file.document_id] });
    await h.documents.worker.drain(admin.workspaceId);
    expect(
      (await h.call(admin, "GET", `/documents/${file.document_id}`)).body.document,
    ).toMatchObject({
      status: "indexed",
    });
    expect((await h.call(nobody, "GET", `/documents/${file.document_id}`)).status).toBe(404);
    expect((await h.call(nobody, "GET", `/vaults/${inbox.vault_id}`)).status).toBe(404);
    expect((await h.call(triage, "GET", `/vaults/${inbox.vault_id}`)).body.vault.my_access).toBe(
      "view",
    );
    const used = await h.ask(triage, { attachments: [file.document_id] });
    expect(used.body.code).toBe("ATTACHMENT_NOT_FOUND");
    expect(request.attachments).toHaveLength(1);
    const added = (await actions(admin)).find((e) => e.action === "intake.attachment_added");
    expect(added).toMatchObject({
      actor_type: "service",
      actor_id: inbox.service_user_id,
      object_id: file.document_id,
      details: { added_by: triage.userId },
    });
  });

  it("keeps no file when who added it can't be recorded", async () => {
    const h = harness();
    const admin = await h.workspace();
    await h.upload(admin, "first.txt");
    h.audit.broken = "intake.attachment_added";
    expect((await h.upload(admin, "second.txt")).status).toBe(500);
    h.audit.broken = null;
    const kept = await pool.query("select name from content.document where workspace_id = $1", [
      admin.workspaceId,
    ]);
    expect(kept.rows).toEqual([{ name: "first.txt" }]);
  });

  it("takes no document from anywhere else", async () => {
    const h = harness();
    const admin = await h.workspace();
    const mine = await h.documents.raw.upload(
      { sessionId: "t", userId: admin.userId, workspaceId: admin.workspaceId },
      { name: "private.txt", bytes: new TextEncoder().encode("secret"), matterId: null },
      { ip: null, userAgent: null },
    );
    if (!mine.ok) throw new Error("upload failed");
    const res = await h.ask(admin, { attachments: [mine.document.id] });
    expect([res.status, res.body.code]).toEqual([422, "ATTACHMENT_NOT_FOUND"]);
  });

  it("keeps the name sent in, so a number never gives away another file", async () => {
    const h = harness();
    const admin = await h.workspace();
    const other = await h.triager(admin);
    await h.upload(admin, "acme.txt", "one");
    const second = await h.upload(other, "acme.txt", "two");
    expect(second.body.attachment.name).toBe("acme.txt");
  });

  it("refuses a file type it can't scan and read", async () => {
    const h = harness();
    const admin = await h.workspace();
    const res = await h.upload(admin, "run.exe", "MZ\0\0\u0001\u0002");
    expect(res.body.code).toBe("UNSUPPORTED_TYPE");
    expect(res.status).toBe(415);
  });

  it("gives the Inbox no way in: no sign-in, no sharing, no new owner", async () => {
    const h = harness();
    const admin = await h.workspace();
    await h.upload(admin);
    const inbox = await inboxOf(admin);
    const { rows } = await pool.query<{ email: string }>(
      `select email from core."user" where id = $1`,
      [inbox.service_user_id],
    );
    const found = await asApp(pool, { userId: null, workspaceId: null }, (db) =>
      db.query("select * from core.find_login_user($1, $2)", [admin.slug, rows[0]?.email]),
    );
    expect(found.rowCount).toBe(0);
    const shared = await h.call(admin, "PUT", `/vaults/${inbox.vault_id}/shares`, {
      grants: [],
      workspace_view: true,
    });
    expect(shared.status).toBe(404);
    const moved = await h.call(admin, "POST", `/admin/vaults/${inbox.vault_id}/transfer`, {
      new_owner_id: admin.userId,
    });
    expect(moved.status).toBe(404);
    const after = await pool.query("select owner_id from content.vault where id = $1", [
      inbox.vault_id,
    ]);
    expect(after.rows[0]).toEqual({ owner_id: inbox.service_user_id });
  });
});
