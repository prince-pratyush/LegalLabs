import { RenderManifest } from "@legallabs/contracts";
import { makePdf } from "@legallabs/ingest/testing";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { createViewer } from "./viewer.js";
import { parseRange } from "./viewer-routes.js";

const pool = testPool();
afterAll(() => pool.end());

const CLAUSE = "The supplier accepts liability for direct loss.";

function harness() {
  const documents = testDocuments(pool);
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: testThreads(pool, documents),
    viewer: createViewer(pool, documents.store, documents),
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
  const upload = async (
    cookie: string,
    name: string,
    content: string | Uint8Array<ArrayBuffer>,
    matterId?: string,
  ) => {
    const form = new FormData();
    form.set("file", new File([content], name));
    if (matterId) form.set("matter_id", matterId);
    const res = await app.request("/api/v1/documents", {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    const { document } = (await res.json()) as { document: { id: string; version_id: string } };
    return { id: document.id, v: document.version_id };
  };
  const get = (cookie: string, path: string, headers: Record<string, string> = {}) =>
    app.request(`/api/v1/documents${path}`, { headers: { cookie, ...headers } });
  return { app, signIn, upload, get };
}

const pdf = () =>
  makePdf([
    ["Page one opens the agreement."],
    ["Clause 2. The supplier accepts liability for direct loss.", "", "Second paragraph."],
    ["Page three closes it."],
  ]);

describe("viewer API", () => {
  it("describes a PDF and audits that it was opened", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    const doc = await h.upload(cookie, "msa.pdf", pdf());
    const res = await h.get(cookie, `/${doc.id}/versions/${doc.v}/manifest`);
    expect(res.status).toBe(200);
    const manifest = RenderManifest.parse(await res.json());
    expect(manifest).toMatchObject({
      render: "pdf",
      status: "indexed",
      page_count: 3,
      file_url: `/api/v1/documents/${doc.id}/versions/${doc.v}/file`,
      attachments: [],
    });
    expect(manifest.pages.map((p) => p.page_no)).toEqual([1, 2, 3]);
    const trail = await auditTrail(pool, m.workspaceId);
    expect(trail.at(-1)).toMatchObject({
      action: "document.previewed",
      object_id: doc.id,
      details: { version_id: doc.v },
    });
  });

  it("returns page text with line boxes that cover a span", async () => {
    const h = harness();
    const cookie = await h.signIn(await seedMember(pool));
    const doc = await h.upload(cookie, "msa.pdf", pdf());
    const res = await h.get(cookie, `/${doc.id}/versions/${doc.v}/pages?from=2&to=3`);
    const { pages } = (await res.json()) as {
      pages: { page_no: number; text: string; lines: { from: number; to: number }[] }[];
    };
    expect(pages.map((p) => p.page_no)).toEqual([2, 3]);
    const page = pages[0];
    const at = page?.text.indexOf("accepts liability") ?? -1;
    expect(at).toBeGreaterThan(0);
    expect(page?.lines.some((line) => line.from <= at && line.to > at)).toBe(true);
  });

  it("refuses more pages than one request may ask for", async () => {
    const h = harness();
    const cookie = await h.signIn(await seedMember(pool));
    const doc = await h.upload(cookie, "msa.pdf", pdf());
    for (const q of ["from=1&to=21", "from=3&to=2", "from=0&to=1", "from=a&to=b"]) {
      expect((await h.get(cookie, `/${doc.id}/versions/${doc.v}/pages?${q}`)).status).toBe(400);
    }
  });

  it("serves the PDF whole or one range at a time", async () => {
    const h = harness();
    const cookie = await h.signIn(await seedMember(pool));
    const bytes = pdf();
    const doc = await h.upload(cookie, "msa.pdf", bytes);
    const path = `/${doc.id}/versions/${doc.v}/file`;
    const whole = await h.get(cookie, path);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-disposition")).toBe("inline");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(new Uint8Array(bytes));

    const part = await h.get(cookie, path, { range: "bytes=0-7" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-7/${bytes.length}`);
    expect(new TextDecoder().decode(await part.arrayBuffer())).toBe("%PDF-1.4");

    const tail = await h.get(cookie, path, { range: "bytes=-5" });
    expect(tail.headers.get("content-range")).toBe(
      `bytes ${bytes.length - 5}-${bytes.length - 1}/${bytes.length}`,
    );
    expect((await h.get(cookie, path, { range: `bytes=${bytes.length}-` })).status).toBe(416);
  });

  it("finds a version by its number, as the spec's /d/ links name it", async () => {
    const h = harness();
    const cookie = await h.signIn(await seedMember(pool));
    const doc = await h.upload(cookie, "msa.pdf", pdf());
    const manifest = await (await h.get(cookie, `/${doc.id}/versions/1/manifest`)).json();
    expect(manifest).toMatchObject({ version_id: doc.v, page_count: 3 });
    expect((await h.get(cookie, `/${doc.id}/versions/1/pages?from=1&to=1`)).status).toBe(200);
    for (const v of ["2", "0", "01", "1e3", "-1"]) {
      expect((await h.get(cookie, `/${doc.id}/versions/${v}/manifest`)).status).toBe(404);
    }
  });

  it("serves no file for kinds painted from text", async () => {
    const h = harness();
    const cookie = await h.signIn(await seedMember(pool));
    const doc = await h.upload(cookie, "a.txt", CLAUSE);
    const manifest = await (await h.get(cookie, `/${doc.id}/versions/${doc.v}/manifest`)).json();
    expect(manifest).toMatchObject({ render: "pages", file_url: null });
    expect((await h.get(cookie, `/${doc.id}/versions/${doc.v}/file`)).status).toBe(404);
  });

  it("finds words inside one version and marks the word itself", async () => {
    const h = harness();
    const cookie = await h.signIn(await seedMember(pool));
    const doc = await h.upload(cookie, "msa.pdf", pdf());
    const other = await h.upload(cookie, "other.txt", CLAUSE);
    const res = await h.get(cookie, `/${doc.id}/versions/${doc.v}/search?q=liability`);
    const { hits } = (await res.json()) as {
      hits: { page: number; char_from: number; char_to: number }[];
    };
    expect(hits).toHaveLength(1);
    expect(hits[0]?.page).toBe(2);
    const pages = await (
      await h.get(cookie, `/${doc.id}/versions/${doc.v}/pages?from=2&to=2`)
    ).json();
    const text = (pages as { pages: { text: string }[] }).pages[0]?.text ?? "";
    expect(text.slice(hits[0]?.char_from, hits[0]?.char_to)).toBe("liability");
    expect(other.id).not.toBe(doc.id);
  });

  it("answers 404 for someone else's document, a walled one, and a mismatched version", async () => {
    const h = harness();
    const owner = await seedMember(pool);
    const cookie = await h.signIn(owner);
    const { rows } = await pool.query<{ id: string }>(
      `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name, wall_mode)
       values ($1, 'C1', 'Client', 'M1', 'M1', 'open') returning id`,
      [owner.workspaceId],
    );
    const matterId = rows[0]?.id ?? "";
    const doc = await h.upload(cookie, "msa.pdf", pdf(), matterId);
    const other = await h.upload(cookie, "b.pdf", pdf());
    const stranger = await h.signIn(await seedMember(pool));
    const paths = (d: { id: string }, v: string) => [
      `/${d.id}/versions/${v}/manifest`,
      `/${d.id}/versions/${v}/pages?from=1&to=1`,
      `/${d.id}/versions/${v}/file`,
      `/${d.id}/versions/${v}/search?q=liability`,
    ];
    for (const path of paths(doc, doc.v)) expect((await h.get(stranger, path)).status).toBe(404);
    for (const path of paths(doc, other.v)) expect((await h.get(cookie, path)).status).toBe(404);
    for (const path of paths({ id: "nope" }, "nope")) {
      expect((await h.get(cookie, path)).status).toBe(404);
    }

    const before = (await auditTrail(pool, owner.workspaceId)).length;
    await pool.query("update core.matter set wall_mode = 'allow_list' where id = $1", [matterId]);
    for (const path of paths(doc, doc.v)) expect((await h.get(cookie, path)).status).toBe(404);
    expect(await auditTrail(pool, owner.workspaceId)).toHaveLength(before);
  });

  it("needs a session", async () => {
    const h = harness();
    const id = "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d4f";
    expect((await h.get("", `/${id}/versions/${id}/manifest`)).status).toBe(401);
  });
});

describe("parseRange", () => {
  it("reads one range, an open end, or a suffix", () => {
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=10-", 100)).toEqual({ start: 10, end: null });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
  });

  it("ignores what it doesn't support", () => {
    for (const header of [undefined, "bytes=-", "bytes=0-1,5-6", "items=0-1", "bytes=a-b"]) {
      expect(parseRange(header, 100)).toBeNull();
    }
  });
});
