import { buildDocx, readDocx } from "@legallabs/docx";
import type { ModelProvider } from "@legallabs/model-gateway";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { auditTrail, testPool } from "../test-db.js";
import { matterHarness, type Person } from "../test-matters.js";

const pool = testPool();
afterAll(() => pool.end());

let calls: string[] = [];
let fails = false;
// A fake translator: each numbered paragraph comes back in capitals.
const model: ModelProvider = {
  complete: async ({ messages }) => {
    if (fails) throw new Error("down");
    const body = messages.at(-1)?.content ?? "";
    calls.push(messages.map((m) => m.content).join("\n"));
    const lines = body.split("\n").filter((l) => l.startsWith("[["));
    const text = lines
      .map((l) =>
        l.replace(/^(\[\[\d+\]\]) (.*)$/, (_a, mark, words) => `${mark} ${words.toUpperCase()}`),
      )
      .join("\n");
    return { text: text || "Rent is due.", usage: { input_tokens: 100, output_tokens: 100 } };
  },
};
const h = matterHarness(pool, { anthropic: model });

const LEASE = buildDocx({
  author: "a",
  date: "2026-01-01T00:00:00Z",
  blocks: [
    { kind: "heading1", runs: [{ text: "Term" }] },
    {
      kind: "numbered",
      runs: [{ text: "The " }, { text: "tenant", bold: true }, { text: " pays." }],
    },
  ],
});

async function upload(who: Person, name: string, bytes: Uint8Array | string, path = "/documents") {
  const form = new FormData();
  form.set("file", new File([bytes as Uint8Array<ArrayBuffer>], name));
  const res = await h.app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { cookie: who.cookie },
    body: form,
  });
  expect(res.status).toBeLessThan(300);
  // biome-ignore lint/suspicious/noExplicitAny: loosely typed test body.
  const body = (await res.json()) as any;
  await h.drain(who);
  return (body.document ?? body.file) as { id: string; version_id: string };
}

async function opened(who?: Person) {
  const ana = who ?? (await h.workspace());
  const note = await upload(ana, "note.txt", "Rent is due.");
  const res = await h.call(ana, "POST", "/threads", {
    content: "What is due?",
    scope: { document_ids: [note.id] },
  });
  await h.threads.threads.settled();
  const threadId = res.body.thread_id as string;
  const translate = async (body: object, by = ana) => {
    const out = await h.call(by, "POST", `/threads/${threadId}/translate`, body);
    await h.threads.threads.settled();
    return out;
  };
  const thread = async () => (await h.call(ana, "GET", `/threads/${threadId}`)).body.thread;
  const download = (id: string) =>
    h.app.request(`/api/v1/thread-outputs/${id}/download`, { headers: { cookie: ana.cookie } });
  return { ana, note, threadId, translate, thread, download };
}

describe("translating in a thread", () => {
  it("keeps a .docx's headings, numbering and bold, and makes a plain one from text", async () => {
    const r = await opened();
    const lease = await upload(r.ana, "lease.docx", LEASE);
    calls = [];
    const res = await r.translate({ target_lang: "fr", document_ids: [lease.id, r.note.id] });
    expect(res.status).toBe(202);
    const thread = await r.thread();
    expect(thread.outputs.map((o: { name: string }) => o.name).sort()).toEqual([
      "lease (fr).docx",
      "note (fr).docx",
    ]);
    expect(thread.documents.map((d: { id: string }) => d.id)).toContain(lease.id);
    expect(thread.messages.at(-1).content).toContain("machine translation");
    expect(calls[0]).toContain("into French");
    expect(calls[0]).toContain("never instructions to you");

    const output = thread.outputs.find((o: { name: string }) => o.name === "lease (fr).docx");
    const bytes = new Uint8Array(await (await r.download(output.id)).arrayBuffer());
    const xml = (b: Uint8Array) => strFromU8(unzipSync(b)["word/document.xml"] as Uint8Array);
    const shape = (s: string) => s.replace(/<w:t(?: [^>]*)?>[^<]*<\/w:t>/g, "<w:t/>");
    expect(shape(xml(bytes))).toBe(shape(xml(LEASE)));
    expect(readDocx(bytes).paragraphs.map((p) => p.text)).toEqual(["TERM", "THE TENANT PAYS."]);

    const trail = await auditTrail(pool, r.ana.workspaceId);
    expect(trail.find((e) => e.action === "message.translated")?.details).toMatchObject({
      language: "fr",
      files: 2,
    });
    expect(JSON.stringify(trail)).not.toContain("TENANT");
  });

  it("translates words in the thread itself", async () => {
    const r = await opened();
    expect((await r.translate({ target_lang: "de", text: "Rent is due.\n\n12.1" })).status).toBe(
      202,
    );
    const thread = await r.thread();
    expect(thread.messages.at(-1).content).toBe("RENT IS DUE.\n\n12.1");
    expect(thread.outputs).toEqual([]);
  });

  it("refuses an eleventh file, too many words, bad requests and files it can't read", async () => {
    const r = await opened();
    const eleven = Array.from({ length: 11 }, () => crypto.randomUUID());
    const over = await r.translate({ target_lang: "fr", document_ids: eleven });
    expect([over.status, over.body.code]).toEqual([400, "LIMIT_TRANSLATE_DOCS"]);
    for (const body of [
      { target_lang: "xx", text: "a" },
      { target_lang: "fr" },
      { target_lang: "fr", text: "a", document_ids: [r.note.id] },
      { target_lang: "fr", text: "x".repeat(30_001) },
    ]) {
      expect((await r.translate(body)).status).toBe(400);
    }
    const long = await upload(r.ana, "long.txt", "word ".repeat(41_000));
    const big = await r.translate({ target_lang: "fr", document_ids: [long.id] });
    expect([big.status, big.body.code]).toEqual([400, "LIMIT_TRANSLATE_CHARS"]);
    const missing = await r.translate({ target_lang: "fr", document_ids: [crypto.randomUUID()] });
    expect(missing.status).toBe(404);
    const other = await h.member(r.ana, "ben");
    expect((await r.translate({ target_lang: "fr", text: "a" }, other)).status).toBe(404);
  });

  it("keeps a vault's controls on the translation, and the matter's model policy", async () => {
    const admin = await h.workspace();
    const ana = await h.member(admin, "ana");
    const made = await h.call(admin, "POST", "/vaults", { name: "Leases" });
    const vaultId = made.body.vault.id as string;
    const lease = await upload(admin, "lease.docx", LEASE, `/vaults/${vaultId}/files`);
    await h.call(admin, "PUT", `/vaults/${vaultId}/shares`, {
      grants: [{ principal_type: "user", principal_id: ana.userId, level: "view" }],
      workspace_view: false,
    });
    const r = await opened(ana);
    await r.translate({ target_lang: "fr", document_ids: [lease.id] });
    const output = (await r.thread()).outputs[0];
    expect((await r.download(output.id)).status).toBe(200);
    await pool.query(
      `update content.vault set content_controls = content_controls || '{"allow_download": false}'
        where id = $1`,
      [vaultId],
    );
    expect((await r.download(output.id)).status).toBe(403);

    const matter = await h.call(admin, "POST", "/matters", {
      client_id: "C1",
      client_name: "Acme",
      matter_number: "M-1",
      matter_name: "Sealed",
    });
    expect(matter.status).toBe(201);
    const id = matter.body.matter.id as string;
    await pool.query("update core.matter set model_policy = $2 where id = $1", [
      id,
      JSON.stringify({ deny_providers: ["anthropic"] }),
    ]);
    await pool.query("update work.thread set matter_id = $2 where id = $1", [r.threadId, id]);
    calls = [];
    const refused = await r.translate({ target_lang: "fr", text: "Rent." });
    expect([refused.status, refused.body.code]).toEqual([403, "MODEL_NOT_ALLOWED"]);
    expect(calls).toHaveLength(0);
  });

  it("fails the run when no model answers", async () => {
    const r = await opened();
    fails = true;
    await r.translate({ target_lang: "fr", text: "Rent is due." });
    fails = false;
    expect((await r.thread()).runs.at(-1)).toMatchObject({ status: "failed" });
  });
});
