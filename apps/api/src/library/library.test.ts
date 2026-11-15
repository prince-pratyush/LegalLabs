import { randomUUID } from "node:crypto";
import { sampleFirmTemplate } from "@legallabs/docx";
import { createGateway } from "@legallabs/model-gateway";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
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
import { createLibrary } from "./library.js";
import { createTemplatePort } from "./port.js";

const pool = testPool();
afterAll(() => pool.end());

type UploadBody = {
  code?: string;
  template: { id: string; current: Record<string, unknown>; [key: string]: unknown };
};

function harness() {
  const documents = testDocuments(pool);
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: testThreads(pool, documents),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
      templates: createTemplatePort(pool),
    }),
    library: createLibrary(pool),
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
  const raw = (cookie: string, path: string) =>
    app.request(`/api/v1${path}`, { headers: { cookie } });
  const upload = async (
    cookie: string,
    path: string,
    name: string,
    bytes: Uint8Array,
    extra: Record<string, string> = {},
  ) => {
    const form = new FormData();
    form.set("file", new File([bytes.slice()], name));
    for (const [key, value] of Object.entries(extra)) form.set(key, value);
    const res = await app.request(`/api/v1${path}`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    return { status: res.status, body: (await res.json()) as UploadBody };
  };
  return { signIn, call, raw, upload };
}

// A second person in the workspace who can draft but not manage the Library.
async function colleague(m: Seeded): Promise<Seeded> {
  const email = `ben-${randomUUID().slice(0, 6)}@${m.slug}.test`;
  const role = await pool.query<{ id: string }>(
    "insert into core.role (workspace_id, name, permissions) values ($1, $2, '{threads.use}') returning id",
    [m.workspaceId, `User ${email}`],
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

// Written as the table owner: drafting itself is tested in drafts.test.ts.
async function draftOf(m: Seeded, body: string) {
  const one = async (sql: string, params: unknown[]) =>
    (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";
  const thread = await one(
    "insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 'Q') returning id",
    [m.workspaceId, m.userId],
  );
  const draft = await one(
    `insert into work.draft (workspace_id, thread_id, owner_id, kind, title)
     values ($1, $2, $3, 'editor', 'Supply terms') returning id`,
    [m.workspaceId, thread, m.userId],
  );
  await pool.query(
    `insert into work.draft_version (workspace_id, draft_id, no, body, author, created_by)
     values ($1, $2, 1, $3, 'user', $4)`,
    [m.workspaceId, draft, body, m.userId],
  );
  return draft;
}

const partsOf = async (res: Response) =>
  Object.fromEntries(
    Object.entries(unzipSync(new Uint8Array(await res.arrayBuffer()))).map(([n, d]) => [
      n,
      strFromU8(d),
    ]),
  );

const actionsOf = async (m: Seeded) =>
  (await auditTrail(pool, m.workspaceId)).map((e) => e.action as string);

describe("saved prompts", () => {
  it("are created with variables, shared, used by others and deleted, all audited", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    const [a, b] = [await h.signIn(ana), await h.signIn(ben)];

    const made = await h.call(a, "POST", "/library/prompts", {
      name: "NDA review",
      text: "Review {{contract}} for {{ party }}.",
    });
    expect(made.status).toBe(201);
    expect(made.body.prompt).toMatchObject({
      variables: ["contract", "party"],
      access: "owner",
      shared: false,
    });
    const id = made.body.prompt.id;

    expect((await h.call(b, "GET", `/library/prompts/${id}`)).status).toBe(404);
    expect((await h.call(b, "GET", "/library/prompts")).body.prompts).toEqual([]);

    const shared = await h.call(a, "PUT", `/library/prompts/${id}/shares`, {
      grants: [{ principal_type: "user", principal_id: ben.userId, level: "use" }],
    });
    expect(shared.status).toBe(200);
    expect(shared.body.shares).toEqual([
      { principal_type: "user", principal_id: ben.userId, label: ben.email, level: "use" },
    ]);
    expect((await h.call(b, "GET", "/library/prompts")).body.prompts).toMatchObject([
      { id, access: "use" },
    ]);
    expect((await h.call(b, "PATCH", `/library/prompts/${id}`, { name: "Mine" })).status).toBe(403);
    expect((await h.call(b, "DELETE", `/library/prompts/${id}`)).status).toBe(403);
    const reshare = await h.call(b, "PUT", `/library/prompts/${id}/shares`, { grants: [] });
    expect(reshare.status).toBe(403);

    const edited = await h.call(a, "PATCH", `/library/prompts/${id}`, {
      description: "For suppliers",
    });
    expect(edited.body.prompt).toMatchObject({ description: "For suppliers", name: "NDA review" });
    expect((await h.call(a, "DELETE", `/library/prompts/${id}`)).status).toBe(204);
    expect((await h.call(b, "GET", `/library/prompts/${id}`)).status).toBe(404);

    expect(await actionsOf(ana)).toEqual(
      expect.arrayContaining([
        "library_item.created",
        "share.granted",
        "library_item.updated",
        "library_item.deleted",
      ]),
    );
  });

  it("refuse bad input and workspace-wide sharing by non-managers", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    const b = await h.signIn(ben);
    expect((await h.call(b, "POST", "/library/prompts", { name: "x", text: "" })).status).toBe(400);
    const long = { name: "x", text: "y".repeat(8001) };
    expect((await h.call(b, "POST", "/library/prompts", long)).status).toBe(400);
    const made = await h.call(b, "POST", "/library/prompts", { name: "Mine", text: "Hi" });
    const everyone = await h.call(b, "PUT", `/library/prompts/${made.body.prompt.id}/shares`, {
      grants: [{ principal_type: "workspace", principal_id: ben.workspaceId, level: "use" }],
    });
    expect(everyone).toMatchObject({ status: 403, body: { code: "SHARING_RESTRICTED" } });
    expect((await h.call(b, "GET", "/library/abilities")).body).toEqual({
      manage: false,
      draft: true,
    });
  });
});

describe("firm templates", () => {
  it("are uploaded by managers, versioned, reverted and previewed", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    const [a, b] = [await h.signIn(ana), await h.signIn(ben)];
    const firm = sampleFirmTemplate({ marks: true });

    expect((await h.upload(b, "/library/templates", "firm.docx", firm)).status).toBe(403);
    expect((await h.upload(a, "/library/templates", "notes.txt", firm)).body.code).toBe("NOT_DOCX");
    const junk = await h.upload(a, "/library/templates", "junk.docx", strToU8("hello"));
    expect(junk.body.code).toBe("NOT_DOCX");
    const macros = zipSync({ ...unzipSync(firm), "word/vbaProject.bin": strToU8("x") });
    expect((await h.upload(a, "/library/templates", "m.docx", macros)).body.code).toBe("MACROS");

    const made = await h.upload(a, "/library/templates", "Firm letter.dotx", firm, {
      name: "Letterhead",
    });
    expect(made.status).toBe(201);
    expect(made.body.template).toMatchObject({
      name: "Letterhead",
      is_default: false,
      current: {
        no: 1,
        file_name: "Firm letter.dotx",
        placeholders: ["{{Counterparty}}", "[INSERT DATE]"],
      },
    });
    const id = made.body.template.id;

    const v2 = await h.upload(
      a,
      `/library/templates/${id}/versions`,
      "v2.docx",
      sampleFirmTemplate(),
      {
        note: "No marks",
      },
    );
    expect(v2.body.template.current).toMatchObject({ no: 2, note: "No marks", placeholders: [] });
    const back = await h.call(a, "POST", `/library/templates/${id}/versions/1/revert`);
    expect(back.body.template.current).toMatchObject({ no: 3, reverted_from: 1 });
    const detail = await h.call(a, "GET", `/library/templates/${id}`);
    expect(detail.body.versions.map((v: { no: number }) => v.no)).toEqual([3, 2, 1]);

    const original = await h.raw(a, `/library/templates/${id}/versions/1/file`);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(firm);

    const pdf = await h.raw(a, `/library/templates/${id}/sample?format=pdf`);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(strFromU8(new Uint8Array(await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    const docx = await partsOf(await h.raw(a, `/library/templates/${id}/sample?format=docx`));
    expect(docx["word/document.xml"]).toContain('w:val="FirmHeading1"');

    // Ben can't see it until it's the default; then he can use it but not change it.
    expect((await h.call(b, "GET", "/library/templates")).body.templates).toEqual([]);
    expect((await h.call(b, "PUT", `/library/templates/${id}/default`, { on: true })).status).toBe(
      404,
    );
    const on = await h.call(a, "PUT", `/library/templates/${id}/default`, { on: true });
    expect(on.body.template.is_default).toBe(true);
    expect((await h.call(b, "GET", "/library/templates")).body.templates).toMatchObject([
      { id, access: "use" },
    ]);
    expect((await h.call(b, "PATCH", `/library/templates/${id}`, { name: "x" })).status).toBe(403);
    expect((await h.call(b, "PUT", `/library/templates/${id}/default`, { on: false })).status).toBe(
      403,
    );

    expect(await actionsOf(ana)).toEqual(
      expect.arrayContaining([
        "template.created",
        "template.version_added",
        "template.exported",
        "template.updated",
      ]),
    );
    expect((await h.call(a, "DELETE", `/library/templates/${id}`)).status).toBe(204);
    expect(await actionsOf(ana)).toContain("template.deleted");
  });
});

describe("exporting a draft through the firm template (exit gate)", () => {
  it("uses the workspace default for .docx and .pdf, and can opt out", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const a = await h.signIn(ana);
    const draft = await draftOf(ana, "# Scope\n\nThe supplier delivers.\n\n1. On time\n2. In full");

    // No default yet: our own plain styles.
    const plain = await partsOf(await h.raw(a, `/drafts/${draft}/export`));
    expect(plain["word/styles.xml"]).toContain('w:ascii="Calibri"');

    const made = await h.upload(a, "/library/templates", "firm.docx", sampleFirmTemplate());
    const id = made.body.template.id;
    await h.call(a, "PUT", `/library/templates/${id}/default`, { on: true });

    const res = await h.raw(a, `/drafts/${draft}/export`);
    expect(res.headers.get("content-disposition")).toContain("Supply%20terms.docx");
    const out = await partsOf(res);
    expect(out["word/styles.xml"]).toContain('w:ascii="Georgia"');
    expect(out["word/document.xml"]).toContain('<w:pStyle w:val="FirmTitle"/>');
    expect(out["word/document.xml"]).toContain('<w:pStyle w:val="FirmHeading1"/>');
    expect(out["word/document.xml"]).toContain('<w:pStyle w:val="FirmListNumber"/>');
    expect(out["word/document.xml"]).toContain('<w:headerReference w:type="default" r:id="rId7"/>');
    expect(out["word/header1.xml"]).toContain("Example Partners · Confidential");

    const tracked = await partsOf(
      await h.raw(a, `/drafts/${draft}/export?tracked_from=1&template=${id}`),
    );
    expect(tracked["word/settings.xml"]).toContain("<w:trackRevisions/>");
    expect(tracked["word/styles.xml"]).toContain('w:ascii="Georgia"');

    const pdf = await h.raw(a, `/drafts/${draft}/export?format=pdf`);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain("Supply%20terms.pdf");

    const none = await partsOf(await h.raw(a, `/drafts/${draft}/export?template=none`));
    expect(none["word/styles.xml"]).toContain('w:ascii="Calibri"');

    const unknown = await h.raw(a, `/drafts/${draft}/export?template=${randomUUID()}`);
    expect([400, 404]).toContain(unknown.status);
    expect((await h.raw(a, `/drafts/${draft}/export?format=pdf&tracked_from=1`)).status).toBe(400);
    expect((await h.raw(a, `/drafts/${draft}/export?format=rtf`)).status).toBe(400);

    const exported = (await auditTrail(pool, ana.workspaceId)).filter(
      (e) => e.action === "draft.exported",
    );
    expect(exported.map((e) => e.details)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ format: "docx", template_version_id: null }),
        expect.objectContaining({ format: "docx", template_version_id: expect.any(String) }),
        expect.objectContaining({ format: "pdf", template_version_id: expect.any(String) }),
      ]),
    );
  });

  it("never exports through a template the caller can't see", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const ben = await colleague(ana);
    const [a, b] = [await h.signIn(ana), await h.signIn(ben)];
    const made = await h.upload(a, "/library/templates", "firm.docx", sampleFirmTemplate());
    const id = made.body.template.id;
    const draft = await draftOf(ben, "Text.");
    expect((await h.raw(b, `/drafts/${draft}/export?template=${id}`)).status).toBe(404);
    // Not the default yet, so Ben's plain export doesn't reach it either.
    const plain = await partsOf(await h.raw(b, `/drafts/${draft}/export`));
    expect(plain["word/styles.xml"]).toContain('w:ascii="Calibri"');
  });
});
