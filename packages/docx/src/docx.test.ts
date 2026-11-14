import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildDocx, citationFootnote } from "./docx.js";
import { inlineRuns, markdownBlocks } from "./markdown.js";
import { buildTrackedDocx } from "./tracked.js";

const DATE = "2026-11-14T03:04:05.678Z";

function parts(bytes: Uint8Array): Record<string, string> {
  return Object.fromEntries(
    Object.entries(unzipSync(bytes)).map(([name, data]) => [name, strFromU8(data)]),
  );
}

function wellFormed(xml: string) {
  const parser = new DOMParser({
    onError: (level, message) => {
      throw new Error(`${level}: ${message}`);
    },
  });
  return parser.parseFromString(xml, "text/xml");
}

const REQUIRED = [
  "[Content_Types].xml",
  "_rels/.rels",
  "word/document.xml",
  "word/_rels/document.xml.rels",
  "word/styles.xml",
  "word/settings.xml",
  "word/numbering.xml",
  "docProps/core.xml",
  "docProps/app.xml",
];

describe("markdownBlocks", () => {
  it("reads headings, lists, paragraphs and emphasis", () => {
    expect(
      markdownBlocks("# Title\n\nFirst line\nsecond line with **bold** and *it*.\n\n- one\n2. two"),
    ).toEqual([
      { kind: "heading1", runs: [{ text: "Title" }] },
      {
        kind: "paragraph",
        runs: [
          { text: "First line second line with " },
          { text: "bold", bold: true },
          { text: " and " },
          { text: "it", italic: true },
          { text: "." },
        ],
      },
      { kind: "bullet", runs: [{ text: "one" }] },
      { kind: "numbered", runs: [{ text: "two" }] },
    ]);
  });

  it("leaves snake_case words alone", () => {
    expect(markdownBlocks("use some_var_name here")[0]?.runs).toEqual([
      { text: "use some_var_name here" },
    ]);
  });

  it("matches the usual emphasis rules", () => {
    expect(inlineRuns("a **b** *c* _d_ e_f_ **g h** *")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " " },
      { text: "c", italic: true },
      { text: " " },
      { text: "d", italic: true },
      { text: " e_f_ " },
      { text: "g h", bold: true },
      { text: " *" },
    ]);
    expect(inlineRuns("**")).toEqual([{ text: "**" }]);
    expect(inlineRuns("***x***")).toEqual([{ text: "*x", bold: true }, { text: "*" }]);
  });

  // A rescan per mark would take minutes here, so a loose bound still catches it
  // without failing on a slow CI machine.
  it("reads a 1 MB line of unmatched marks quickly", () => {
    for (const unit of [" _a", " **a", " *a", "_a"]) {
      const line = unit.repeat(Math.ceil(1_000_000 / unit.length));
      const started = performance.now();
      const runs = inlineRuns(line);
      expect(performance.now() - started, unit).toBeLessThan(5000);
      expect(runs.length).toBeGreaterThan(0);
    }
  }, 30_000);
});

describe("buildDocx", () => {
  const blocks = markdownBlocks("# Memo\n\nThe cap is **12 months**.\n\n- a\n- b\n\n1. x\n2. y");

  it("has every part, all well formed", () => {
    const files = parts(buildDocx({ title: "Memo", blocks, author: "Ana", date: DATE }));
    for (const name of REQUIRED) expect(files[name], name).toBeDefined();
    for (const [name, xml] of Object.entries(files))
      expect(() => wellFormed(xml), name).not.toThrow();
    expect(files["word/footnotes.xml"]).toBeUndefined();
    expect(files["docProps/core.xml"]).toContain("2026-11-14T03:04:05Z");
  });

  it("gives each list its own numbering", () => {
    const files = parts(buildDocx({ blocks, author: "Ana", date: DATE }));
    expect(files["word/numbering.xml"]).toContain('w:numId="2"');
    expect(files["word/document.xml"]).toContain('<w:numId w:val="1"/>');
    expect(files["word/document.xml"]).toContain('<w:numId w:val="2"/>');
  });

  it("is the same bytes for the same input", () => {
    const one = buildDocx({ blocks, author: "Ana", date: DATE });
    expect(buildDocx({ blocks, author: "Ana", date: DATE })).toEqual(one);
  });

  it("escapes markup and drops characters XML can't hold", () => {
    const evil = [{ kind: "paragraph" as const, runs: [{ text: 'a <b> & "c"\u0001\u0008 d' }] }];
    const files = parts(buildDocx({ blocks: evil, author: 'A & "B"', date: DATE }));
    const doc = files["word/document.xml"] ?? "";
    expect(() => wellFormed(doc)).not.toThrow();
    expect(doc).toContain("a &lt;b&gt; &amp; &quot;c&quot; d");
    expect(() => wellFormed(files["docProps/core.xml"] ?? "")).not.toThrow();
  });

  it("writes citations as footnotes", () => {
    const withNote = [
      { kind: "paragraph" as const, runs: [{ text: "The cap is 12 months." }, { footnote: 1 }] },
    ];
    const note = citationFootnote({ document: "MSA.pdf", page: 14, quote: "shall not exceed" });
    expect(note).toBe('MSA.pdf, p. 14: "shall not exceed"');
    const files = parts(
      buildDocx({ blocks: withNote, author: "Ana", date: DATE, footnotes: [note] }),
    );
    expect(files["word/footnotes.xml"]).toContain("MSA.pdf, p. 14: &quot;shall not exceed&quot;");
    expect(files["word/document.xml"]).toContain('<w:footnoteReference w:id="1"/>');
    expect(files["[Content_Types].xml"]).toContain("footnotes+xml");
    expect(files["word/_rels/document.xml.rels"]).toContain("footnotes.xml");
    expect(() => wellFormed(files["word/footnotes.xml"] ?? "")).not.toThrow();
  });

  it("refuses a date that isn't valid or is outside 1980-2099", () => {
    for (const date of [
      "not a date",
      "1979-12-31T23:59:59Z",
      "2100-01-01T00:00:00Z",
      new Date(Number.NaN),
    ]) {
      expect(() => buildDocx({ blocks, author: "Ana", date }), String(date)).toThrow(
        /1980 and 2099/,
      );
      expect(
        () => buildTrackedDocx({ before: "a", after: "b", author: "A", date }),
        String(date),
      ).toThrow(/1980 and 2099/);
    }
    expect(() => buildDocx({ blocks, author: "Ana", date: "1980-01-01T00:00:00Z" })).not.toThrow();
  });

  it("refuses a reference to a missing footnote", () => {
    const bad = [{ kind: "paragraph" as const, runs: [{ footnote: 2 }] }];
    expect(() => buildDocx({ blocks: bad, author: "Ana", date: DATE, footnotes: ["one"] })).toThrow(
      RangeError,
    );
  });
});

describe("buildTrackedDocx", () => {
  const before =
    "# Terms\n\nPayment is due within 30 days.\n\nThis clause goes away.\n\nKept as is.";
  const after =
    "# Terms\n\nPayment is due within 14 business days.\n\nKept as is.\n\n- A brand new item";
  const files = parts(buildTrackedDocx({ before, after, author: "LegalLabs", date: DATE }));
  const doc = files["word/document.xml"] ?? "";

  it("is well formed and turns tracking on", () => {
    for (const [name, xml] of Object.entries(files))
      expect(() => wellFormed(xml), name).not.toThrow();
    expect(files["word/settings.xml"]).toContain("<w:trackRevisions/>");
  });

  it("marks word-level edits as insertions and deletions", () => {
    expect(doc).toMatch(
      /<w:del [^>]*w:author="LegalLabs"[^>]*><w:r><w:delText xml:space="preserve">30<\/w:delText>/,
    );
    expect(doc).toMatch(
      /<w:ins [^>]*><w:r><w:t xml:space="preserve">14 business<\/w:t><\/w:r><\/w:ins>/,
    );
    expect(doc).toContain('w:date="2026-11-14T03:04:05Z"');
  });

  it("marks whole removed and added paragraphs on the paragraph mark", () => {
    expect(doc).toMatch(
      /<w:pPr><w:rPr><w:del [^>]*\/><\/w:rPr><\/w:pPr><w:del [^>]*>.*This clause goes away/,
    );
    expect(doc).toMatch(
      /<w:numPr>.*<w:rPr><w:ins [^>]*\/><\/w:rPr><\/w:pPr><w:ins [^>]*>.*A brand new item/,
    );
  });

  it("gives every revision a unique id", () => {
    const ids = [...doc.matchAll(/<w:(?:ins|del|pPrChange) w:id="(\d+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(3);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("records a style change", () => {
    const restyled = parts(
      buildTrackedDocx({ before: "Scope", after: "## Scope", author: "A", date: DATE }),
    )["word/document.xml"];
    expect(restyled).toContain('<w:pStyle w:val="Heading2"/><w:pPrChange');
  });

  it("replaces an unrelated paragraph whole rather than word by word", () => {
    const swapped = parts(
      buildTrackedDocx({
        before: "Intro.\n\nThis clause will be removed.",
        after: "Intro.\n\nA new carve-out for data breaches.",
        author: "A",
        date: DATE,
      }),
    )["word/document.xml"];
    expect(swapped).toMatch(/<w:rPr><w:del [^>]*\/><\/w:rPr>.*This clause will be removed/);
    expect(swapped).toMatch(/<w:rPr><w:ins [^>]*\/><\/w:rPr>.*A new carve-out for data breaches/);
  });

  it("stays quick on a large rewrite, replacing it whole past the pairing limit", () => {
    const para = (tag: string, i: number) => `${tag} paragraph ${i} about the supply of goods`;
    const before = Array.from({ length: 150 }, (_, i) => para("Old", i)).join("\n\n");
    const after = Array.from({ length: 150 }, (_, i) => para("New", i)).join("\n\n");
    const started = performance.now();
    const doc = parts(buildTrackedDocx({ before, after, author: "A", date: DATE }))[
      "word/document.xml"
    ];
    expect(performance.now() - started).toBeLessThan(5000);
    expect(() => wellFormed(doc ?? "")).not.toThrow();
    // Every old paragraph removed whole, every new one added whole.
    expect(doc?.match(/<w:rPr><w:del /g)).toHaveLength(150);
    expect(doc?.match(/<w:rPr><w:ins /g)).toHaveLength(150);
  });

  it("still pairs similar paragraphs in a smaller rewrite", () => {
    const para = (tag: string, i: number) => `${tag} paragraph ${i} about the supply of goods`;
    const before = Array.from({ length: 40 }, (_, i) => para("Old", i)).join("\n\n");
    const after = Array.from({ length: 40 }, (_, i) => para("New", i)).join("\n\n");
    const doc = parts(buildTrackedDocx({ before, after, author: "A", date: DATE }))[
      "word/document.xml"
    ];
    expect(doc).not.toMatch(/<w:rPr><w:(ins|del) /);
    expect(doc?.match(/<w:delText xml:space="preserve">Old<\/w:delText>/g)).toHaveLength(40);
  });

  it("leaves an unchanged draft without revisions", () => {
    const same = parts(buildTrackedDocx({ before, after: before, author: "A", date: DATE }));
    expect(same["word/document.xml"]).not.toMatch(/<w:(ins|del) /);
  });
});
