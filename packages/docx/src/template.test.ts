import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildDocx } from "./docx.js";
import { markdownBlocks } from "./markdown.js";
import { sampleFirmTemplate } from "./sample.js";
import { openTemplate, placeholders, TemplateError } from "./template.js";
import { buildTrackedDocx } from "./tracked.js";

const DATE = "2026-11-15T01:02:03Z";
const DRAFT = `# Scope

The supplier **must** deliver on time.

1. First duty
2. Second duty

Between the lists.

1. Starts again

- a point`;

const parts = (bytes: Uint8Array) =>
  Object.fromEntries(Object.entries(unzipSync(bytes)).map(([n, d]) => [n, strFromU8(d)]));

function wellFormed(xml: string) {
  return new DOMParser({
    onError: (level, message) => {
      throw new Error(`${level}: ${message}`);
    },
  }).parseFromString(xml, "text/xml");
}

const exportDraft = (template: Uint8Array, extra: { footnotes?: string[] } = {}) =>
  parts(
    buildDocx({
      title: "Supply terms",
      blocks: markdownBlocks(DRAFT),
      author: "Ada Lovelace",
      date: DATE,
      template,
      ...extra,
    }),
  );

describe("export through a firm template (exit gate)", () => {
  const template = parts(sampleFirmTemplate());
  const out = exportDraft(sampleFirmTemplate());
  const doc = out["word/document.xml"] ?? "";

  it("keeps the firm's styles, fonts and page setup", () => {
    // The firm's style sheet is kept whole; ours only fills gaps.
    const firmStyles = template["word/styles.xml"] ?? "";
    expect(out["word/styles.xml"]).toContain(firmStyles.slice(0, -"</w:styles>".length));
    expect(out["word/styles.xml"]).toContain('<w:rFonts w:ascii="Georgia"');
    expect(out["word/styles.xml"]).not.toContain('w:ascii="Calibri"');
    expect(doc).toContain('<w:pgSz w:w="12240" w:h="15840"/>');
    expect(doc).not.toContain('w:w="11906"');
  });

  it("formats the draft with the firm's styles, found by Word's built-in names", () => {
    expect(doc).toContain(
      '<w:p><w:pPr><w:pStyle w:val="FirmTitle"/></w:pPr><w:r><w:t xml:space="preserve">Supply terms</w:t></w:r></w:p>',
    );
    expect(doc).toMatch(/<w:pStyle w:val="FirmHeading1"\/><\/w:pPr><w:r><w:t[^>]*>Scope</);
    expect(doc).not.toContain('w:val="Heading1"');
    expect(doc).not.toContain('w:val="Title"');
  });

  it("keeps the firm's header and footer on the draft's section", () => {
    expect(out["word/header1.xml"]).toBe(template["word/header1.xml"]);
    expect(out["word/footer1.xml"]).toBe(template["word/footer1.xml"]);
    expect(doc).toContain('<w:headerReference w:type="default" r:id="rId7"/>');
    expect(doc).toContain('<w:footerReference w:type="default" r:id="rId8"/>');
    expect(out["word/_rels/document.xml.rels"]).toContain('Target="header1.xml"');
  });

  it("numbers lists with the firm's scheme, each list restarting at (a)", () => {
    const numbering = out["word/numbering.xml"] ?? "";
    // The firm's lettered scheme is still there, and both numbered lists use it.
    expect(numbering).toContain('<w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%1)"/>');
    const numbered = [
      ...doc.matchAll(
        /<w:pStyle w:val="FirmListNumber"\/><w:numPr><w:ilvl w:val="0"\/><w:numId w:val="(\d+)"\/>/g,
      ),
    ].map((m) => m[1]);
    expect(numbered).toHaveLength(3);
    expect(new Set(numbered).size).toBe(2);
    for (const id of new Set(numbered)) {
      expect(numbering).toMatch(
        new RegExp(
          `<w:num w:numId="${id}"><w:abstractNumId w:val="3"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/>`,
        ),
      );
    }
    // The firm has no bullet style, so bullets get our own list, numbered after the firm's.
    expect(numbering).toMatch(/<w:abstractNum w:abstractNumId="4">[\s\S]*?w:numFmt w:val="bullet"/);
    expect(doc).toContain('<w:pStyle w:val="ListParagraph"/>');
    expect(out["word/styles.xml"]).toContain('w:styleId="ListParagraph"');
  });

  it("drops the template's sample body and records our author", () => {
    expect(doc).not.toContain("Sample body text");
    expect(out["docProps/core.xml"]).toContain("<dc:creator>Ada Lovelace</dc:creator>");
    expect(out["docProps/core.xml"]).not.toContain("Template author");
  });

  it("writes well-formed parts and the same bytes for the same input", () => {
    for (const [name, xml] of Object.entries(out)) {
      if (name.endsWith(".xml") || name.endsWith(".rels")) wellFormed(xml);
    }
    const again = () =>
      buildDocx({
        blocks: markdownBlocks(DRAFT),
        author: "A",
        date: DATE,
        template: sampleFirmTemplate(),
      });
    expect(again()).toEqual(again());
  });
});

describe("templates with marks", () => {
  it("puts the title and draft where the marks are and keeps the rest", () => {
    const doc = exportDraft(sampleFirmTemplate({ marks: true }))["word/document.xml"] ?? "";
    const letterhead = doc.indexOf("Level 9, 1 Example Street");
    const title = doc.indexOf(">Supply terms<");
    const scope = doc.indexOf(">Scope<");
    const signoff = doc.indexOf("Signed for {{Counterparty}}");
    expect(letterhead).toBeGreaterThan(-1);
    expect(letterhead).toBeLessThan(title);
    expect(title).toBeLessThan(scope);
    expect(scope).toBeLessThan(signoff);
    expect(doc).not.toContain("{{content}}");
    expect(doc).not.toContain("{{title}}");
    // The title keeps the mark's paragraph style; no second title is added.
    expect(doc.match(/Supply terms/g)).toHaveLength(1);
    expect(doc).toContain(
      '<w:pStyle w:val="FirmTitle"/></w:pPr><w:r><w:t xml:space="preserve">Supply terms',
    );
  });

  it("lists the placeholders left for the lawyer, not our own marks", () => {
    expect(placeholders(sampleFirmTemplate({ marks: true }))).toEqual([
      "{{Counterparty}}",
      "[INSERT DATE]",
    ]);
  });
});

describe("other template shapes", () => {
  it("saves a .dotx as a document", () => {
    const out = exportDraft(sampleFirmTemplate({ dotx: true }));
    expect(out["[Content_Types].xml"]).toContain("wordprocessingml.document.main+xml");
    expect(out["[Content_Types].xml"]).not.toContain("template.main+xml");
  });

  it("adds footnotes to a template that had none", () => {
    const blocks = [{ kind: "paragraph" as const, runs: [{ text: "Held" }, { footnote: 1 }] }];
    const out = parts(
      buildDocx({
        blocks,
        author: "A",
        date: DATE,
        footnotes: ["Case, p. 2"],
        template: sampleFirmTemplate(),
      }),
    );
    expect(out["word/footnotes.xml"]).toContain("Case, p. 2");
    const rels = out["word/_rels/document.xml.rels"] ?? "";
    expect(rels).toMatch(/Type="[^"]*\/footnotes" Target="footnotes.xml"/);
    const ids = [...rels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(out["[Content_Types].xml"]).toContain('PartName="/word/footnotes.xml"');
    const settings = out["word/settings.xml"] ?? "";
    expect(settings.indexOf("<w:footnotePr>")).toBeGreaterThan(-1);
    expect(settings.indexOf("<w:footnotePr>")).toBeLessThan(settings.indexOf("<w:compat>"));
  });

  it("keeps tracked changes on, in schema order", () => {
    const out = parts(
      buildTrackedDocx({
        before: "Old text.",
        after: "New text.",
        author: "A",
        date: DATE,
        template: sampleFirmTemplate(),
      }),
    );
    expect(out["word/settings.xml"]).toContain(
      '<w:zoom w:percent="110"/><w:trackRevisions/><w:defaultTabStop',
    );
    expect(out["word/document.xml"]).toContain("<w:ins ");
    expect(out["word/document.xml"]).toContain("<w:del ");
  });

  it("refuses files that aren't usable Word documents", () => {
    const problem = (bytes: Uint8Array) => {
      try {
        openTemplate(bytes);
        return null;
      } catch (err) {
        return err instanceof TemplateError ? err.problem : "other";
      }
    };
    expect(problem(sampleFirmTemplate())).toBeNull();
    expect(problem(strToU8("not a zip"))).toBe("NOT_DOCX");
    const withMacros = { ...unzipSync(sampleFirmTemplate()), "word/vbaProject.bin": strToU8("x") };
    expect(problem(zipSync(withMacros))).toBe("MACROS");
    const noBody = { ...unzipSync(sampleFirmTemplate()) };
    delete noBody["word/document.xml"];
    expect(problem(zipSync(noBody))).toBe("NOT_DOCX");
  });
});

describe("hostile templates", () => {
  const withParts = (extra: Record<string, string>) =>
    zipSync({
      ...unzipSync(sampleFirmTemplate()),
      ...Object.fromEntries(Object.entries(extra).map(([n, x]) => [n, strToU8(x)])),
    });
  const problemOf = (bytes: Uint8Array) => {
    try {
      openTemplate(bytes);
      return null;
    } catch (err) {
      return err instanceof TemplateError ? err.problem : "other";
    }
  };

  it("reads a body of unclosed paragraphs in linear time", () => {
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const doc = `<w:document xmlns:w="${W}"><w:body>${"<w:p><w:r><w:t>x</w:t></w:r>".repeat(60_000)}</w:body></w:document>`;
    const bytes = withParts({ "word/document.xml": doc });
    const started = performance.now();
    expect(placeholders(bytes)).toEqual([]);
    // The old lazy regex took minutes on this; a linear scan takes milliseconds.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("refuses links that reach out and embedded objects, but keeps hyperlinks", () => {
    const rels = (type: string, target: string) =>
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}" TargetMode="External"/></Relationships>`;
    expect(
      problemOf(
        withParts({
          "word/_rels/settings.xml.rels": rels("attachedTemplate", "file://host/share/t.dotm"),
        }),
      ),
    ).toBe("ACTIVE_CONTENT");
    expect(problemOf(withParts({ "word/embeddings/oleObject1.bin": "x" }))).toBe("ACTIVE_CONTENT");
    expect(problemOf(withParts({ "word/activeX/activeX1.xml": "<x/>" }))).toBe("ACTIVE_CONTENT");
    expect(
      problemOf(
        withParts({ "word/_rels/footer1.xml.rels": rels("hyperlink", "https://example.test") }),
      ),
    ).toBeNull();
  });

  it("keeps a `$` in footnote text as text", () => {
    const notes = `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p/></w:footnote></w:footnotes>`;
    const firm = unzipSync(sampleFirmTemplate());
    firm["word/footnotes.xml"] = strToU8(notes);
    firm["word/_rels/document.xml.rels"] = strToU8(
      strFromU8(firm["word/_rels/document.xml.rels"] as Uint8Array).replace(
        "</Relationships>",
        '<Relationship Id="rId20" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>',
      ),
    );
    const out = parts(
      buildDocx({
        blocks: [{ kind: "paragraph", runs: [{ text: "Fee" }, { footnote: 1 }] }],
        author: "A",
        date: DATE,
        footnotes: ["Costs $` and $& apply"],
        template: zipSync(firm),
      }),
    );
    expect(out["word/footnotes.xml"]).toContain("Costs $` and $&amp; apply");
    expect(out["word/document.xml"]).toContain('<w:footnoteReference w:id="2"/>');
  });
});
