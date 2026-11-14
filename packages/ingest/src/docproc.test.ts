import { describe, expect, it } from "vitest";
import { createDocprocParser, DocprocUnavailable } from "./docproc.js";
import { createIngest } from "./index.js";
import { processFile } from "./process.js";
import { makePdf } from "./testing.js";

const answer =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TEXT = "1. Scope\n\nThe supplier accepts liability.";
const good = {
  ok: true,
  mime: "application/pdf",
  pages: [
    {
      page_no: 1,
      width: 612,
      height: 792,
      text: TEXT,
      blocks: [{ from: 0, to: 8, x0: 72, y0: 70, x1: 140, y1: 82 }],
      headings: [{ from: 0, to: 8, level: 1, text: "1. Scope" }],
      ocr: true,
    },
  ],
  children: [{ name: "note.txt", content_base64: Buffer.from("hi").toString("base64") }],
};

const parse = (body: unknown, status = 200) =>
  createDocprocParser({ url: "http://docproc", fetch: answer(body, status) })(
    new Uint8Array([1]),
    "a.pdf",
  );

describe("docproc parser", () => {
  it("keeps the sidecar's text and offsets exactly", async () => {
    const result = await parse(good);
    if (!result.ok) throw new Error(result.reason);
    expect(result.pages[0]?.text).toBe(TEXT);
    expect(result.chunks.map((c) => [c.text, c.section])).toEqual([
      ["1. Scope\n\nThe supplier accepts liability.", "1. Scope"],
    ]);
    expect(result.ocrPages).toEqual([1]);
    expect(result.children?.map((c) => [c.name, Buffer.from(c.bytes).toString()])).toEqual([
      ["note.txt", "hi"],
    ]);
  });

  it("passes on a failure the sidecar reports", async () => {
    expect(await parse({ ok: false, reason: "ENCRYPTED_NO_PASSWORD" })).toEqual({
      ok: false,
      reason: "ENCRYPTED_NO_PASSWORD",
    });
  });

  it.each([
    ["an offset past the text", { blocks: [{ from: 0, to: 999, x0: 0, y0: 0, x1: 1, y1: 1 }] }],
    ["a heading past the text", { headings: [{ from: 5, to: 999, level: 1, text: "x" }] }],
    ["a control character", { text: `a\u0001b`, blocks: [], headings: [] }],
    ["a missing page", { page_no: 2 }],
  ])("refuses an answer with %s", async (_, change) => {
    const page = { ...good.pages[0], ...change };
    expect(await parse({ ...good, pages: [page] })).toEqual({ ok: false, reason: "INTERNAL" });
  });

  it("refuses a malformed answer", async () => {
    expect(await parse({ ok: true, pages: "nope" })).toEqual({ ok: false, reason: "INTERNAL" });
  });

  it("says when the sidecar can't be reached", async () => {
    await expect(parse({}, 503)).rejects.toBeInstanceOf(DocprocUnavailable);
    const down = createDocprocParser({
      url: "http://docproc",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(down(new Uint8Array([1]), "a.pdf")).rejects.toBeInstanceOf(DocprocUnavailable);
  });
});

describe("createIngest", () => {
  const pdf = makePdf([["The supplier accepts liability."]]);
  const unreachable = async () => {
    throw new TypeError("fetch failed");
  };

  it("reads a PDF with pdf.js when the sidecar is down", async () => {
    const ingest = createIngest({
      docprocUrl: "http://docproc",
      fetch: unreachable,
      local: processFile,
    });
    const result = await ingest(pdf, "a.pdf");
    expect(result).toMatchObject({ ok: true, mime: "application/pdf" });
  });

  it("waits for the sidecar for types only it can read", async () => {
    const ingest = createIngest({
      docprocUrl: "http://docproc",
      fetch: unreachable,
      local: processFile,
    });
    expect(await ingest(new TextEncoder().encode("From: a@example.test"), "a.eml")).toEqual({
      ok: false,
      reason: "INTERNAL",
    });
  });

  it("refuses those types when no sidecar is set", async () => {
    expect(
      await createIngest({ local: processFile })(new TextEncoder().encode("x"), "a.eml"),
    ).toEqual({
      ok: false,
      reason: "UNSUPPORTED_TYPE",
    });
  });

  it("reads plain text itself, even with a sidecar", async () => {
    const ingest = createIngest({
      docprocUrl: "http://docproc",
      fetch: unreachable,
      local: processFile,
    });
    expect(await ingest(new TextEncoder().encode("Hello."), "a.txt")).toMatchObject({ ok: true });
  });
});
