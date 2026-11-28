import { STARTERS } from "@legallabs/contracts";
import { createGateway, type ModelProvider } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
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
import { denyProviders, fileInMatter, newMatter } from "../test-model-policy.js";
import { createPlaybooks } from "./playbooks.js";

const pool = testPool();
afterAll(() => pool.end());

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTRACT =
  "1. Liability. The supplier's total liability is capped at the fees paid in the twelve months before the claim.\n2. Term. This agreement lasts for two years.";

function harness(reply: () => string = () => '{"rules":[]}', asksPerWindow = 20) {
  const provider: ModelProvider = {
    complete: async () => ({ text: reply(), usage: { input_tokens: 10, output_tokens: 10 } }),
  };
  const gateway = createGateway({
    providers: { anthropic: provider },
    recordUsage: async () => {},
  });
  const documents = testDocuments(pool);
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: { ...testThreads(pool, documents), asksPerWindow },
    drafts: createDrafts(pool, { gateway }),
    playbooks: createPlaybooks(pool, { gateway }),
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
  const call = async (cookie: string, method: string, path: string, json?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { app, documents, signIn, call };
}

// Another person in the same workspace, holding only the given permissions.
async function colleague(m: Seeded, name: string, permissions: string[]) {
  const one = async (sql: string, params: unknown[]) =>
    (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";
  const roleId = await one(
    "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
    [m.workspaceId, name, permissions],
  );
  const email = `${name}@${m.slug}.test`;
  const userId = await one(
    `insert into core."user" (workspace_id, email, role_id, status)
     values ($1, $2, $3, 'active') returning id`,
    [m.workspaceId, email, roleId],
  );
  await pool.query(
    "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
    [m.workspaceId, userId, await hashPassword(PASSWORD)],
  );
  return { ...m, userId, email };
}

const rule = (title: string) => ({ title, standard_position: `${title} position.` });
const scratch = (rules = [rule("Term")]) => ({
  name: "NDA positions",
  contract_type: "NDA",
  source: { kind: "scratch", rules },
});

describe("playbooks API", () => {
  it("saves every change as a version and keeps rule ids", async () => {
    const h = harness();
    const ana = await h.signIn(await seedMember(pool));
    const created = await h.call(ana, "POST", "/playbooks", scratch());
    expect(created.status).toBe(201);
    const pb = created.body.playbook;
    expect(pb).toMatchObject({ status: "unpublished", version_no: 1, access: "manage" });
    const termId = pb.rules[0].id;
    expect(termId).toMatch(V7);

    const patched = await h.call(ana, "PATCH", `/playbooks/${pb.id}`, {
      base_version_no: 1,
      guidance: "We are the customer.",
      rules: [{ id: termId, ...rule("Term") }, rule("Liability")],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.playbook.version_no).toBe(2);
    expect(patched.body.playbook.rules.map((r: { id: string }) => r.id)[0]).toBe(termId);
    expect(patched.body.playbook.rules[1]).toMatchObject({ title: "Liability", ordinal: 1 });

    const renamed = await h.call(ana, "PATCH", `/playbooks/${pb.id}`, {
      base_version_no: 2,
      name: "NDA v2",
    });
    expect(renamed.body.playbook).toMatchObject({ name: "NDA v2", version_no: 3 });

    const versions = await h.call(ana, "GET", `/playbooks/${pb.id}/versions`);
    expect(versions.body.versions.map((v: { no: number }) => v.no)).toEqual([3, 2, 1]);
    const first = await h.call(ana, "GET", `/playbooks/${pb.id}/versions/1`);
    expect(first.body.playbook).toMatchObject({ name: "NDA positions", version_no: 1 });
    expect(first.body.playbook.rules).toHaveLength(1);
    expect((await h.call(ana, "GET", `/playbooks/${pb.id}/versions/9`)).status).toBe(404);
  });

  it("refuses a 201st rule and a repeated title with 422", async () => {
    const h = harness();
    const ana = await h.signIn(await seedMember(pool));
    const pb = (await h.call(ana, "POST", "/playbooks", scratch())).body.playbook;
    const many = Array.from({ length: 200 }, (_, i) => rule(`Rule ${i}`));
    const full = await h.call(ana, "PATCH", `/playbooks/${pb.id}`, {
      base_version_no: 1,
      rules: many,
    });
    expect(full.status).toBe(200);
    const over = await h.call(ana, "PATCH", `/playbooks/${pb.id}`, {
      base_version_no: 2,
      rules: [...many, rule("One more")],
    });
    expect(over).toMatchObject({ status: 422, body: { code: "RULE_LIMIT" } });
    const twice = await h.call(ana, "PATCH", `/playbooks/${pb.id}`, {
      base_version_no: 2,
      rules: [rule("Term"), rule("term")],
    });
    expect(twice).toMatchObject({ status: 422, body: { code: "DUPLICATE_RULE_TITLE" } });
  });

  it("hides an unpublished playbook from users until an approver publishes it", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const ana = await h.signIn(m);
    const ben = await h.signIn(await colleague(m, "ben", ["playbooks.use"]));
    const pb = (await h.call(ana, "POST", "/playbooks", scratch())).body.playbook;

    expect((await h.call(ben, "GET", "/playbooks")).body.playbooks).toEqual([]);
    expect((await h.call(ben, "GET", `/playbooks/${pb.id}`)).status).toBe(404);

    const published = await h.call(ana, "POST", `/playbooks/${pb.id}/publish`);
    expect(published.body.playbook.status).toBe("published");
    const seen = await h.call(ben, "GET", "/playbooks?filter[status]=published");
    expect(seen.body.playbooks).toMatchObject([{ id: pb.id, access: "view", rule_count: 1 }]);
    const byType = (type: string) =>
      h.call(ben, "GET", `/playbooks?filter[status]=published&filter[contract_type]=${type}`);
    expect((await byType("nda")).body.playbooks).toHaveLength(1);
    expect((await byType("MSA")).body.playbooks).toEqual([]);
    expect(
      (await h.call(ben, "PATCH", `/playbooks/${pb.id}`, { base_version_no: 1, name: "x" })).status,
    ).toBe(403);
    const trail = await auditTrail(pool, m.workspaceId);
    expect(trail.map((e) => e.action)).toContain("playbook.published");
  });

  it("keeps readers on the published version while the owner edits", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const ana = await h.signIn(m);
    const cal = await h.signIn(await colleague(m, "cal", ["playbooks.use", "playbooks.create"]));
    const ben = await h.signIn(await colleague(m, "ben", ["playbooks.use"]));
    const pb = (await h.call(cal, "POST", "/playbooks", scratch())).body.playbook;
    const published = (await h.call(ana, "POST", `/playbooks/${pb.id}/publish`)).body.playbook;
    expect(published).toMatchObject({ published_version_no: 1, has_unpublished_changes: false });

    const edited = await h.call(cal, "PATCH", `/playbooks/${pb.id}`, {
      base_version_no: 1,
      name: "Looser NDA",
      rules: [rule("Term"), rule("Non-solicit")],
    });
    expect(edited.body.playbook).toMatchObject({
      name: "Looser NDA",
      version_no: 2,
      published_version_no: 1,
      has_unpublished_changes: true,
    });

    const seen = async () => (await h.call(ben, "GET", `/playbooks/${pb.id}`)).body.playbook;
    expect(await seen()).toMatchObject({ name: "NDA positions", version_no: 1 });
    expect((await seen()).rules).toHaveLength(1);
    const listed = (await h.call(ben, "GET", "/playbooks?filter[status]=published")).body;
    expect(listed.playbooks).toMatchObject([{ name: "NDA positions", rule_count: 1 }]);
    const versions = (await h.call(ben, "GET", `/playbooks/${pb.id}/versions`)).body.versions;
    expect(versions.map((v: { no: number }) => v.no)).toEqual([1]);
    expect((await h.call(ben, "GET", `/playbooks/${pb.id}/versions/2`)).status).toBe(404);

    // Only an approver's publish moves readers on.
    expect((await h.call(cal, "POST", `/playbooks/${pb.id}/publish`)).status).toBe(403);
    await h.call(ana, "POST", `/playbooks/${pb.id}/publish`);
    expect(await seen()).toMatchObject({ name: "Looser NDA", version_no: 2 });
    const actions = (await auditTrail(pool, m.workspaceId)).map((e) => e.action);
    expect(actions.filter((a) => a === "playbook.published")).toHaveLength(2);
  });

  it("lets an author draft but not publish their own playbook", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cal = await h.signIn(await colleague(m, "cal", ["playbooks.use", "playbooks.create"]));
    const pb = (await h.call(cal, "POST", "/playbooks", scratch())).body.playbook;
    expect(pb.access).toBe("edit");
    expect(
      (await h.call(cal, "PATCH", `/playbooks/${pb.id}`, { base_version_no: 1, name: "Mine" }))
        .status,
    ).toBe(200);
    expect(await h.call(cal, "POST", `/playbooks/${pb.id}/publish`)).toMatchObject({
      status: 403,
      body: { code: "FORBIDDEN" },
    });
    const ana = await h.signIn(m);
    expect((await h.call(ana, "POST", `/playbooks/${pb.id}/publish`)).status).toBe(200);

    const ben = await h.signIn(await colleague(m, "ben", ["playbooks.use"]));
    expect((await h.call(ben, "POST", "/playbooks", scratch())).status).toBe(403);
  });

  it("starts from a template or a copy of another playbook", async () => {
    const h = harness();
    const ana = await h.signIn(await seedMember(pool));
    const nda = await h.call(ana, "POST", "/playbooks", {
      name: "Our NDA",
      contract_type: "NDA",
      source: { kind: "starter", template: "nda" },
    });
    expect(nda.status).toBe(201);
    expect(nda.body.playbook.rules).toHaveLength(STARTERS.nda.rules.length);
    expect(nda.body.playbook.guidance).toBe(STARTERS.nda.guidance);

    const copy = await h.call(ana, "POST", "/playbooks", {
      name: "Copy",
      contract_type: "NDA",
      source: { kind: "playbook", playbook_id: nda.body.playbook.id },
    });
    expect(copy.body.playbook.rules.map((r: { title: string }) => r.title)).toEqual(
      nda.body.playbook.rules.map((r: { title: string }) => r.title),
    );
    expect(copy.body.playbook.rules[0].id).not.toBe(nda.body.playbook.rules[0].id);
  });

  it("generates rules from an example contract and checks each quote", async () => {
    const reply = JSON.stringify({
      rules: [
        {
          title: "Limitation of liability",
          standard_position: "Liability is capped at twelve months' fees.",
          fallbacks: ["Eighteen months' fees."],
          flag: true,
          source_quote: "total liability is capped at the fees paid in the twelve months",
        },
        {
          title: "Term",
          standard_position: "Two years.",
          source_quote: "This agreement renews automatically every year.",
        },
        { title: "", standard_position: "dropped" },
      ],
    });
    const h = harness(() => `Here you go:\n\`\`\`json\n${reply}\n\`\`\``);
    const m = await seedMember(pool);
    const principal = { sessionId: "s", userId: m.userId, workspaceId: m.workspaceId };
    const uploaded = await h.documents.upload(
      principal,
      { name: "msa.txt", bytes: new TextEncoder().encode(CONTRACT), matterId: null },
      { ip: null, userAgent: null },
    );
    if (!uploaded.ok) throw new Error(uploaded.reason);
    const ana = await h.signIn(m);
    const created = await h.call(ana, "POST", "/playbooks", {
      name: "MSA positions",
      contract_type: "MSA",
      source: { kind: "document", document_id: uploaded.document.id },
    });
    expect(created.status).toBe(201);
    const { rules, status } = created.body.playbook;
    expect(status).toBe("unpublished");
    expect(rules).toHaveLength(2);
    expect(rules[0].provenance).toEqual({
      document_id: uploaded.document.id,
      quote: "total liability is capped at the fees paid in the twelve months",
      verified: true,
    });
    expect(rules[1].provenance).toBeNull();

    // Where a rule came from is for its authors: a reader gets the rules alone.
    const pbId = created.body.playbook.id;
    await h.call(ana, "POST", `/playbooks/${pbId}/publish`);
    const ben = await h.signIn(await colleague(m, "ben", ["playbooks.use"]));
    const read = await h.call(ben, "GET", `/playbooks/${pbId}`);
    expect(read.body.playbook.rules[0]).not.toHaveProperty("provenance");
    expect(created.body.generation).toEqual({ parts_read: 1, parts_total: 1 });

    const trail = await auditTrail(pool, m.workspaceId);
    const generated = trail.find((e) => e.action === "playbook.generated");
    expect(generated?.details).toEqual({
      source_kind: "document",
      input_count: 1,
      rule_count: 2,
      verified_count: 1,
    });
    expect(JSON.stringify(trail)).not.toContain("twelve months");
  });

  it("reports a missing document and a model that finds nothing", async () => {
    const h = harness(() => "I could not find anything.");
    const m = await seedMember(pool);
    const ana = await h.signIn(m);
    const body = (documentId: string) => ({
      name: "x",
      contract_type: "MSA",
      source: { kind: "document", document_id: documentId },
    });
    const missing = await h.call(
      ana,
      "POST",
      "/playbooks",
      body("0190a000-0000-7000-8000-000000000000"),
    );
    expect(missing.status).toBe(404);
    const principal = { sessionId: "s", userId: m.userId, workspaceId: m.workspaceId };
    const uploaded = await h.documents.upload(
      principal,
      { name: "msa.txt", bytes: new TextEncoder().encode(CONTRACT), matterId: null },
      { ip: null, userAgent: null },
    );
    if (!uploaded.ok) throw new Error(uploaded.reason);
    const nothing = await h.call(ana, "POST", "/playbooks", body(uploaded.document.id));
    expect(nothing).toMatchObject({ status: 422, body: { code: "NO_RULES_FOUND" } });
  });

  it("shares by grant and deletes for approvers only", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const ana = await h.signIn(m);
    const benUser = await colleague(m, "ben", ["playbooks.use"]);
    const ben = await h.signIn(benUser);
    const pb = (await h.call(ana, "POST", "/playbooks", scratch())).body.playbook;

    const granted = await h.call(ana, "PUT", `/playbooks/${pb.id}/grants`, [
      { principal_type: "user", principal_id: benUser.userId, level: "edit" },
    ]);
    expect(granted.status).toBe(200);
    expect((await h.call(ben, "GET", `/playbooks/${pb.id}`)).body.playbook.access).toBe("edit");
    expect((await h.call(ben, "DELETE", `/playbooks/${pb.id}`)).status).toBe(403);
    expect((await h.call(ben, "PUT", `/playbooks/${pb.id}/grants`, [])).status).toBe(403);
    const stranger = await h.call(ana, "PUT", `/playbooks/${pb.id}/grants`, [
      {
        principal_type: "user",
        principal_id: "0190a000-0000-7000-8000-000000000000",
        level: "view",
      },
    ]);
    expect(stranger).toMatchObject({ status: 422, body: { code: "INVALID_PRINCIPAL" } });

    expect((await h.call(ana, "DELETE", `/playbooks/${pb.id}`)).status).toBe(204);
    expect((await h.call(ana, "GET", `/playbooks/${pb.id}`)).status).toBe(404);
    const actions = (await auditTrail(pool, m.workspaceId)).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["playbook.created", "playbook.grant_changed", "playbook.deleted"]),
    );
  });
});

describe("playbook edits and limits", () => {
  it("refuses a save made from an out-of-date version, and an empty one", async () => {
    const h = harness();
    const ana = await h.signIn(await seedMember(pool));
    const pb = (await h.call(ana, "POST", "/playbooks", scratch())).body.playbook;
    const save = (base: number, body: object) =>
      h.call(ana, "PATCH", `/playbooks/${pb.id}`, { base_version_no: base, ...body });
    expect((await save(1, { name: "First" })).status).toBe(200);
    expect(await save(1, { name: "Second" })).toMatchObject({
      status: 409,
      body: { code: "STALE" },
    });
    expect(await save(2, {})).toMatchObject({ status: 400, body: { code: "INVALID_REQUEST" } });
    expect((await h.call(ana, "PATCH", `/playbooks/${pb.id}`, { name: "x" })).status).toBe(400);
    const versions = await h.call(ana, "GET", `/playbooks/${pb.id}/versions`);
    expect(versions.body.versions).toHaveLength(2);
  });

  it("refuses conditions that point nowhere, at the rule itself or in a circle", async () => {
    const h = harness();
    const ana = await h.signIn(await seedMember(pool));
    const pb = (await h.call(ana, "POST", "/playbooks", scratch())).body.playbook;
    const termId = pb.rules[0].id;
    const on = (ruleId: string) => ({ kind: "rule_status", rule_id: ruleId, equals: "acceptable" });
    const save = (rules: object[]) =>
      h.call(ana, "PATCH", `/playbooks/${pb.id}`, { base_version_no: 1, rules });
    const missing = await save([
      { id: termId, ...rule("Term") },
      { ...rule("Liability"), condition: on("0190a000-0000-7000-8000-000000000fff") },
    ]);
    expect(missing).toMatchObject({ status: 422, body: { code: "INVALID_CONDITION" } });
    const self = await save([{ id: termId, ...rule("Term"), condition: on(termId) }]);
    expect(self.body.code).toBe("INVALID_CONDITION");
    const other = "0190a000-0000-7000-8000-000000000abc";
    const circle = await save([
      { id: termId, ...rule("Term"), condition: on(other) },
      { id: other, ...rule("Liability"), condition: on(termId) },
    ]);
    expect(circle.body.code).toBe("INVALID_CONDITION");
    const chain = await save([
      { id: termId, ...rule("Term") },
      { ...rule("Liability"), condition: on(termId) },
    ]);
    expect(chain.status).toBe(200);
  });

  it("caps a request body at 4 MB, as drafts do", async () => {
    const h = harness();
    const ana = await h.signIn(await seedMember(pool));
    const pb = (await h.call(ana, "POST", "/playbooks", scratch())).body.playbook;
    const huge = { base_version_no: 1, guidance: "x".repeat(4 * 1024 * 1024) };
    const res = await h.call(ana, "PATCH", `/playbooks/${pb.id}`, huge);
    expect(res).toMatchObject({ status: 413, body: { code: "TOO_LARGE" } });
  });

  it("refuses filters with control characters as a bad request", async () => {
    const h = harness();
    const ana = await h.signIn(await seedMember(pool));
    expect((await h.call(ana, "GET", "/playbooks?q=a%00b")).status).toBe(400);
    expect((await h.call(ana, "GET", "/playbooks?filter[contract_type]=%00")).status).toBe(400);
  });

  it("checks permission and the ask limit before calling a model", async () => {
    let calls = 0;
    const h = harness(() => {
      calls += 1;
      return JSON.stringify({ rules: [{ title: "Term", standard_position: "Two years." }] });
    }, 1);
    const m = await seedMember(pool);
    const principal = { sessionId: "s", userId: m.userId, workspaceId: m.workspaceId };
    const uploaded = await h.documents.upload(
      principal,
      { name: "msa.txt", bytes: new TextEncoder().encode(CONTRACT), matterId: null },
      { ip: null, userAgent: null },
    );
    if (!uploaded.ok) throw new Error(uploaded.reason);
    const body = {
      name: "From a contract",
      contract_type: "MSA",
      source: { kind: "document", document_id: uploaded.document.id },
    };
    const ben = await h.signIn(await colleague(m, "ben", ["playbooks.use", "threads.use"]));
    expect((await h.call(ben, "POST", "/playbooks", body)).status).toBe(403);
    expect(calls).toBe(0);

    const ana = await h.signIn(m);
    expect((await h.call(ana, "POST", "/playbooks", body)).status).toBe(201);
    const limited = await h.call(ana, "POST", "/playbooks", body);
    expect(limited).toMatchObject({ status: 429, body: { code: "TOO_MANY_REQUESTS" } });
    expect(calls).toBe(1);
  });
});

describe("a matter's model policy in playbook generation", () => {
  it("refuses to read a matter's contract when no model is left", async () => {
    let calls = 0;
    const h = harness(() => {
      calls++;
      return '{"rules":[]}';
    });
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    const principal = { sessionId: "s", userId: m.userId, workspaceId: m.workspaceId };
    const uploaded = await h.documents.upload(
      principal,
      { name: "msa.txt", bytes: new TextEncoder().encode(CONTRACT), matterId: null },
      { ip: null, userAgent: null },
    );
    if (!uploaded.ok) throw new Error(uploaded.reason);
    await h.documents.worker.drain(m.workspaceId);
    const matterId = await newMatter(pool, m);
    await fileInMatter(pool, uploaded.document.versionId, matterId);
    await denyProviders(pool, matterId, "anthropic");
    const res = await h.call(cookie, "POST", "/playbooks", {
      name: "From contract",
      contract_type: "MSA",
      source: { kind: "document", document_id: uploaded.document.id },
    });
    expect(res).toMatchObject({ status: 403, body: { code: "MODEL_NOT_ALLOWED" } });
    expect(calls).toBe(0);
  });
});
