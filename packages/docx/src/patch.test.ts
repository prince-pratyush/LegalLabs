import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paraHash } from "@legallabs/contracts";
import { DOMParser, type Element } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildDocx } from "./docx.js";
import { markdownBlocks } from "./markdown.js";
import { type PatchEdit, paragraphFragment, patchDocx } from "./patch.js";
import { readDocx, unzipLimited } from "./read.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = `xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14"`;

const NUMBERED_PPR =
  '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr><w:ind w:left="1440" w:hanging="360"/></w:pPr>';

const textBox = (text: string) =>
  `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="914400" cy="457200"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="1" name="Text Box 1"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr><wps:txbx><w:txbxContent><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape style="width:72pt;height:36pt"><v:textbox><w:txbxContent><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;

const BODY = [
  // 0-1: a TOC field spanning two paragraphs.
  '<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Definitions</w:t></w:r><w:r><w:tab/><w:t>1</w:t></w:r></w:p>',
  '<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:t>Services</w:t></w:r><w:r><w:tab/><w:t>2</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
  // 2: heading.
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Definitions</w:t></w:r></w:p>',
  // 3: a numbered clause with mixed formatting and a footnote reference.
  `<w:p w14:paraId="1A2B3C4D">${NUMBERED_PPR}<w:bookmarkStart w:id="0" w:name="clause"/><w:r w:rsidR="00AB12CD"><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">The Supplier </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">shall deliver the Goods within thirty (30) days</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r><w:bookmarkEnd w:id="0"/><w:r><w:t xml:space="preserve"> of the order &amp; acceptance.</w:t></w:r></w:p>`,
  // 4: a paragraph anchoring a text box.
  `<w:p><w:r><w:t xml:space="preserve">Anchor text </w:t></w:r>${textBox("Boxed text")}<w:r><w:t>after the box.</w:t></w:r></w:p>`,
  // 5-6: a table.
  '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
  // 7: someone else's tracked changes.
  '<w:p><w:r><w:t xml:space="preserve">Payment is due </w:t></w:r><w:del w:id="101" w:author="Opposing Counsel" w:date="2026-01-02T03:04:05Z"><w:r><w:delText>fourteen</w:delText></w:r></w:del><w:ins w:id="102" w:author="Opposing Counsel" w:date="2026-01-02T03:04:05Z"><w:r><w:t>thirty</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> days after invoice.</w:t></w:r></w:p>',
  // 8: a block content control.
  '<w:sdt><w:sdtPr><w:alias w:val="Signature"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Signature block</w:t></w:r></w:p></w:sdtContent></w:sdt>',
  // 9: a cross-reference field.
  '<w:p><w:r><w:t xml:space="preserve">See clause </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF clause \\r </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1.1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> for the  delivery terms.</w:t></w:r></w:p>',
].join("");

const SECT =
  '<w:sectPr><w:headerReference w:type="default" r:id="rId4"/><w:footerReference w:type="default" r:id="rId5"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';

const rel = (id: string, type: string, target: string) =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const override = (part: string, type: string) =>
  `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"/>`;

type Parts = Record<string, string | Uint8Array>;

function fixture(
  options: { settings?: boolean; body?: string; edit?: (parts: Parts) => void } = {},
): Uint8Array {
  const settings = options.settings ?? true;
  const body = options.body ?? BODY;
  const parts: Parts = {
    "[Content_Types].xml": `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${override("/word/document.xml", "document.main")}${override("/word/styles.xml", "styles")}${settings ? override("/word/settings.xml", "settings") : ""}${override("/word/numbering.xml", "numbering")}${override("/word/footnotes.xml", "footnotes")}${override("/word/header1.xml", "header")}${override("/word/footer1.xml", "footer")}</Types>`,
    "_rels/.rels": `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("rId1", "officeDocument", "word/document.xml")}</Relationships>`,
    "word/_rels/document.xml.rels": `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("rId1", "styles", "styles.xml")}${settings ? rel("rId2", "settings", "settings.xml") : ""}${rel("rId3", "numbering", "numbering.xml")}${rel("rId4", "header", "header1.xml")}${rel("rId5", "footer", "footer1.xml")}${rel("rId6", "footnotes", "footnotes.xml")}${rel("rId7", "image", "media/image1.png")}</Relationships>`,
    "word/document.xml": `${HEAD}<w:document ${NS}><w:body>${body}${SECT}</w:body></w:document>`,
    "word/styles.xml": `${HEAD}<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style></w:styles>`,
    "word/numbering.xml": `${HEAD}<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    "word/footnotes.xml": `${HEAD}<w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> As defined in the Order.</w:t></w:r></w:p></w:footnote></w:footnotes>`,
    "word/header1.xml": `${HEAD}<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>Confidential header</w:t></w:r></w:p></w:hdr>`,
    "word/footer1.xml": `${HEAD}<w:ftr xmlns:w="${W}"><w:p><w:r><w:t>Page footer</w:t></w:r></w:p></w:ftr>`,
    "word/media/image1.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 255]),
  };
  if (settings) {
    parts["word/settings.xml"] =
      `${HEAD}<w:settings xmlns:w="${W}"><w:zoom w:percent="100"/><w:proofState w:spelling="clean"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/></w:settings>`;
  }
  options.edit?.(parts);
  const mtime = new Date("2026-01-01T00:00:00Z");
  return zipSync(
    Object.fromEntries(
      Object.entries(parts).map(([name, data]) => [
        name,
        [typeof data === "string" ? strToU8(data) : data, { mtime }],
      ]),
    ),
  );
}

const OPTS = { author: "Counsel", date: "2026-11-15T10:00:00Z" };

function parse(xml: string) {
  return new DOMParser({
    onError: (level, message) => {
      throw new Error(`${level}: ${message}`);
    },
  }).parseFromString(xml, "text/xml");
}

const parts = (bytes: Uint8Array) => unzipSync(bytes);
const part = (bytes: Uint8Array, name: string) => {
  const data = parts(bytes)[name];
  if (!data) throw new Error(`missing ${name}`);
  return strFromU8(data);
};
const all = (doc: ReturnType<typeof parse>, tag: string) =>
  Array.from(doc.getElementsByTagNameNS(W, tag)) as Element[];

/** The body's top-level paragraphs and table-cell paragraphs, as readDocx indexes them. */
const bodyParagraphs = (doc: ReturnType<typeof parse>) =>
  all(doc, "p").filter((p) => {
    for (let at = p.parentNode; at; at = at.parentNode) {
      if ((at as Element).localName === "txbxContent") return false;
    }
    return true;
  });

const replace = (over: Partial<PatchEdit> = {}): PatchEdit => ({
  id: "s1",
  kind: "replace",
  paragraph_index: 3,
  before: "The Supplier shall",
  after: "The Vendor shall",
  ...over,
});

describe("readDocx", () => {
  const read = readDocx(fixture());

  it("indexes body paragraphs as Office.js does, skipping text boxes", () => {
    expect(read.paragraphs.map((p) => p.text)).toEqual([
      "Definitions\t1",
      "Services\t2",
      "Definitions",
      "The Supplier shall deliver the Goods within thirty (30) days of the order & acceptance.",
      "Anchor text after the box.",
      "Cell A",
      "Cell B",
      "Payment is due thirty days after invoice.",
      "Signature block",
      "See clause 1.1 for the  delivery terms.",
    ]);
    expect(read.paragraphs.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(read.paragraphs.filter((p) => p.excluded).map((p) => p.index)).toEqual([0, 1, 8]);
    expect(read.charCount).toBe(read.paragraphs.reduce((n, p) => n + p.text.length + 1, 0));
  });

  it("counts the regions it will not edit", () => {
    expect(read.excludedRegions).toEqual({
      header: 1,
      footer: 1,
      footnote: 1,
      endnote: 0,
      toc: 1,
      text_box: 1,
      content_control: 1,
      field: 1,
    });
  });

  it("reports style, section path and runs", () => {
    const clause = read.paragraphs[3];
    expect(clause?.style).toBe("ListParagraph");
    expect(clause?.section_path).toBe("1 > 1.1");
    expect(read.paragraphs[2]?.section_path).toBe("1");
    expect(clause?.runs).toEqual([
      { run_index: 0, char_from: 0, char_to: 13 },
      { run_index: 1, char_from: 13, char_to: 60 },
      { run_index: 2, char_from: 60, char_to: 87 },
    ]);
  });

  it("lists existing tracked changes", () => {
    expect(read.existingEdits).toEqual([
      {
        paragraph_index: 7,
        kind: "del",
        text: "fourteen",
        author: "Opposing Counsel",
        date: "2026-01-02T03:04:05Z",
      },
      {
        paragraph_index: 7,
        kind: "ins",
        text: "thirty",
        author: "Opposing Counsel",
        date: "2026-01-02T03:04:05Z",
      },
    ]);
  });

  it("hashes paragraphs exactly as the contract's paraHash", async () => {
    for (const p of read.paragraphs) expect(p.para_hash).toBe(await paraHash(p.text));
    const odd = buildDocx({
      blocks: markdownBlocks("Soft­hyphen​ and  nbsp ﬁ"),
      author: "a",
      date: OPTS.date,
    });
    const [para] = readDocx(odd).paragraphs;
    expect(para?.para_hash).toBe(await paraHash(para?.text ?? ""));
    expect(para?.para_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("patchDocx", () => {
  const original = fixture();

  it("tracks a replacement with one w:del/w:ins pair, a comment and preserved formatting", () => {
    const result = patchDocx(original, [replace({ comment: "Rule: say Vendor" })], OPTS);
    expect(result).toMatchObject({ applied: ["s1"], failed: [] });
    const xml = part(result.bytes, "word/document.xml");
    const doc = parse(xml);
    const dels = all(doc, "del").filter((d) => d.getAttribute("w:author") === "Counsel");
    const ins = all(doc, "ins").filter((d) => d.getAttribute("w:author") === "Counsel");
    expect(dels).toHaveLength(1);
    expect(ins).toHaveLength(1);
    expect(dels[0]?.textContent).toBe("Supplier");
    expect(ins[0]?.textContent).toBe("Vendor");
    expect(ins[0]?.getAttribute("w:date")).toBe("2026-11-15T10:00:00Z");
    // The new run takes the bold of the run it replaces.
    expect(all(ins[0] as unknown as ReturnType<typeof parse>, "b")).toHaveLength(1);
    // Ids sit above everything already in the document.
    for (const el of [...dels, ...ins])
      expect(Number(el.getAttribute("w:id"))).toBeGreaterThan(102);

    const paragraph = bodyParagraphs(doc)[3] as Element;
    const source = xml.slice(xml.indexOf('<w:p w14:paraId="1A2B3C4D">'));
    expect(source.startsWith(`<w:p w14:paraId="1A2B3C4D">${NUMBERED_PPR}`)).toBe(true);
    expect(all(paragraph as never, "footnoteReference")).toHaveLength(1);
    expect(all(paragraph as never, "commentRangeStart")).toHaveLength(1);
    expect(all(paragraph as never, "commentReference")).toHaveLength(1);
    // Runs outside the change are untouched, rsid and all.
    expect(source).toContain(
      '<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">shall deliver the Goods within thirty (30) days</w:t></w:r>',
    );
    expect(source).toContain(
      '<w:r w:rsidR="00AB12CD"><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">The </w:t></w:r>',
    );

    const comments = parse(part(result.bytes, "word/comments.xml"));
    const [comment] = all(comments, "comment");
    expect(comment?.textContent).toBe("Rule: say Vendor");
    expect(comment?.getAttribute("w:author")).toBe("Counsel");
    expect(part(result.bytes, "word/_rels/document.xml.rels")).toContain('Target="comments.xml"');
    expect(part(result.bytes, "[Content_Types].xml")).toContain('PartName="/word/comments.xml"');
    expect(part(result.bytes, "word/settings.xml")).toContain(
      '<w:proofState w:spelling="clean"/><w:trackRevisions/><w:defaultTabStop',
    );

    const after = readDocx(result.bytes);
    expect(after.paragraphs[3]?.text).toBe(
      "The Vendor shall deliver the Goods within thirty (30) days of the order & acceptance.",
    );
    expect(after.paragraphs).toHaveLength(10);
  });

  it("copies every other part byte for byte", () => {
    const result = patchDocx(original, [replace({ comment: "c" })], OPTS);
    const before = parts(original);
    const after = parts(result.bytes);
    const touched = new Set([
      "word/document.xml",
      "word/comments.xml",
      "word/settings.xml",
      "[Content_Types].xml",
      "word/_rels/document.xml.rels",
    ]);
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), "word/comments.xml"].sort());
    for (const [name, data] of Object.entries(before)) {
      if (!touched.has(name)) expect(after[name], name).toEqual(data);
    }
    // Paragraphs other than the edited one are unchanged too.
    const xmlBefore = part(original, "word/document.xml");
    const xmlAfter = part(result.bytes, "word/document.xml");
    const cut = xmlBefore.indexOf('<w:p w14:paraId="1A2B3C4D">');
    expect(xmlAfter.slice(0, cut)).toBe(xmlBefore.slice(0, cut));
    const tail = xmlBefore.slice(xmlBefore.indexOf('<w:p><w:r><w:t xml:space="preserve">Anchor'));
    expect(xmlAfter.endsWith(tail)).toBe(true);
  });

  it("inserts a tracked paragraph after the anchor with its style and numbering", () => {
    const result = patchDocx(
      original,
      [
        {
          id: "n1",
          kind: "insert_after",
          paragraph_index: 3,
          before: "",
          after: "New clause.",
          comment: "Why",
        },
      ],
      OPTS,
    );
    expect(result.applied).toEqual(["n1"]);
    const doc = parse(part(result.bytes, "word/document.xml"));
    const added = bodyParagraphs(doc)[4] as Element;
    expect(added.textContent).toBe("New clause.");
    const pPr = all(added as never, "pPr")[0];
    expect(all(pPr as never, "numId")[0]?.getAttribute("w:val")).toBe("1");
    expect(all(pPr as never, "pStyle")[0]?.getAttribute("w:val")).toBe("ListParagraph");
    expect(all(pPr as never, "ins")).toHaveLength(1);
    expect(all(added as never, "ins")).toHaveLength(2);
    expect(readDocx(result.bytes).paragraphs.map((p) => p.text)[4]).toBe("New clause.");
  });

  it("applies several edits to one paragraph in order", () => {
    const result = patchDocx(
      original,
      [replace(), replace({ id: "s2", before: "thirty (30) days", after: "sixty (60) days" })],
      OPTS,
    );
    expect(result.applied).toEqual(["s1", "s2"]);
    expect(readDocx(result.bytes).paragraphs[3]?.text).toBe(
      "The Vendor shall deliver the Goods within sixty (60) days of the order & acceptance.",
    );
  });

  it("matches before with loose whitespace and keeps the rest", () => {
    const result = patchDocx(
      original,
      [
        replace({
          paragraph_index: 9,
          before: "for the delivery\nterms.",
          after: "for the payment terms.",
        }),
      ],
      OPTS,
    );
    expect(result.failed).toEqual([]);
    expect(readDocx(result.bytes).paragraphs[9]?.text).toBe(
      "See clause 1.1 for the payment terms.",
    );
  });

  it("reports anchor failures and refuses excluded or locked text", () => {
    const result = patchDocx(
      original,
      [
        replace({ id: "missing", before: "The Buyer shall" }),
        replace({ id: "twice", paragraph_index: 2, before: "", after: "x" }),
        replace({ id: "repeated", before: "the", after: "a" }),
        replace({ id: "range", paragraph_index: 42 }),
        replace({ id: "toc", paragraph_index: 0, before: "Definitions", after: "Terms" }),
        replace({ id: "sdt", paragraph_index: 8, before: "Signature", after: "Execution" }),
        replace({ id: "field", paragraph_index: 9, before: "clause 1.1", after: "clause 2.1" }),
        replace({ id: "theirs", paragraph_index: 7, before: "due thirty", after: "due sixty" }),
        replace({ id: "same", before: "The Supplier", after: "The Supplier" }),
      ],
      OPTS,
    );
    expect(result.applied).toEqual([]);
    expect(result.failed).toEqual([
      { id: "missing", code: "ANCHOR_FAILED" },
      { id: "twice", code: "ANCHOR_FAILED" },
      { id: "repeated", code: "ANCHOR_FAILED" },
      { id: "range", code: "ANCHOR_FAILED" },
      { id: "toc", code: "EXCLUDED_REGION" },
      { id: "sdt", code: "EXCLUDED_REGION" },
      { id: "field", code: "EXCLUDED_REGION" },
      { id: "theirs", code: "UNSUPPORTED_CONTENT" },
      { id: "same", code: "NO_CHANGE" },
    ]);
    expect(part(result.bytes, "word/document.xml")).toBe(part(original, "word/document.xml"));
  });

  it("is deterministic for the same inputs", () => {
    const edits = [
      replace({ comment: "c" }),
      replace({ id: "s2", paragraph_index: 5, before: "Cell A", after: "Cell Z" }),
    ];
    const a = patchDocx(original, edits, OPTS);
    const b = patchDocx(fixture(), edits, OPTS);
    expect(a.bytes).toEqual(b.bytes);
    const later = patchDocx(original, edits, { ...OPTS, date: "2026-11-16T10:00:00Z" });
    const strip = (xml: string) => xml.replaceAll(/w:date="[^"]*"/g, "");
    expect(strip(part(later.bytes, "word/document.xml"))).toBe(
      strip(part(a.bytes, "word/document.xml")),
    );
  });

  it("creates settings.xml when the package has none and can leave tracking off", () => {
    const bare = fixture({ settings: false });
    const result = patchDocx(bare, [replace()], OPTS);
    expect(part(result.bytes, "word/settings.xml")).toContain("<w:trackRevisions/>");
    expect(part(result.bytes, "word/_rels/document.xml.rels")).toContain('Target="settings.xml"');
    expect(part(result.bytes, "[Content_Types].xml")).toContain('PartName="/word/settings.xml"');
    const untracked = patchDocx(original, [replace()], { ...OPTS, trackRevisions: false });
    expect(part(untracked.bytes, "word/settings.xml")).toBe(part(original, "word/settings.xml"));
  });

  it("appends to an existing comments part", () => {
    const once = patchDocx(original, [replace({ comment: "first" })], OPTS);
    const twice = patchDocx(
      once.bytes,
      [replace({ id: "s2", before: "thirty (30)", after: "sixty (60)", comment: "second" })],
      OPTS,
    );
    const comments = all(parse(part(twice.bytes, "word/comments.xml")), "comment");
    expect(comments.map((c) => c.textContent)).toEqual(["first", "second"]);
    const ids = comments.map((c) => Number(c.getAttribute("w:id")));
    expect(new Set(ids).size).toBe(2);
    expect(part(twice.bytes, "word/_rels/document.xml.rels").match(/comments\.xml/g)).toHaveLength(
      1,
    );
  });

  it("patches a document the builder made", () => {
    const built = buildDocx({
      blocks: markdownBlocks("# Terms\n\n1. The fee is **ten** dollars."),
      author: "a",
      date: OPTS.date,
    });
    const index = readDocx(built).paragraphs.findIndex((p) => p.text.includes("fee"));
    const result = patchDocx(
      built,
      [replace({ paragraph_index: index, before: "ten dollars", after: "twenty dollars" })],
      OPTS,
    );
    expect(result.failed).toEqual([]);
    expect(readDocx(result.bytes).paragraphs[index]?.text).toBe("The fee is twenty dollars.");
  });
});

const utf16 = (xml: string) => {
  const out = new Uint8Array(2 + xml.length * 2);
  out.set([0xff, 0xfe]);
  for (let i = 0; i < xml.length; i++) {
    const code = xml.charCodeAt(i);
    out[2 + 2 * i] = code & 0xff;
    out[3 + 2 * i] = code >> 8;
  }
  return out;
};

describe("untrusted packages", () => {
  const failure = (bytes: Uint8Array) => {
    try {
      patchDocx(bytes, [replace()], OPTS);
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return "none";
  };

  it("refuses a part that inflates past the limit without inflating it", () => {
    const bomb = fixture({ edit: (parts) => void (parts["word/media/big.bin"] = new Uint8Array(21 * 1024 * 1024)) });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(failure(bomb)).toBe("TOO_LARGE");
    expect(() => readDocx(bomb)).toThrow(expect.objectContaining({ code: "TOO_LARGE" }));
  });

  it("refuses too many entries and too many bytes in total", () => {
    const many = fixture({
      edit: (parts) => {
        for (let i = 0; i < 2_001; i++) parts[`word/media/x${i}.bin`] = new Uint8Array(1);
      },
    });
    expect(failure(many)).toBe("TOO_LARGE");
    expect(() =>
      unzipLimited(fixture(), { entries: 100, partBytes: 1_000_000, totalBytes: 2_000 }),
    ).toThrow(expect.objectContaining({ code: "TOO_LARGE" }));
  });

  it("reports unreadable input as OOXML_INVALID", () => {
    const deep = `<w:p><w:r><w:t>x</w:t></w:r></w:p>${"<w:tbl>".repeat(20_000)}${"</w:tbl>".repeat(20_000)}`;
    const cases = [
      new Uint8Array([1, 2, 3, 4]),
      fixture({ edit: (parts) => void delete parts["word/document.xml"] }),
      fixture({ body: deep }),
      fixture({ body: "<w:p><w:r><w:t>&#x110000;</w:t></w:r></w:p>" }),
      fixture({
        edit: (parts) =>
          void (parts["word/document.xml"] = `${HEAD}<x:document xmlns:x="${W}"><x:body/></x:document>`),
      }),
    ];
    for (const bytes of cases) expect(failure(bytes)).toBe("OOXML_INVALID");
    expect(() => paragraphFragment(cases[0] as Uint8Array, replace(), OPTS)).toThrow(
      expect.objectContaining({ code: "OOXML_INVALID" }),
    );
  });

  it("only writes the spec's parts, whatever the relationships say", () => {
    const withRel = (extra: string) =>
      fixture({
        edit: (parts) => {
          const rels = parts["word/_rels/document.xml.rels"] as string;
          parts["word/_rels/document.xml.rels"] = rels.replace(
            "</Relationships>",
            `${extra}</Relationships>`,
          );
        },
      });
    const hostile = withRel(rel("rId9", "comments", "document.xml"));
    expect(() => patchDocx(hostile, [replace({ comment: "c" })], OPTS)).toThrow(
      expect.objectContaining({ code: "OOXML_INVALID" }),
    );
    const external = withRel(
      '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="https://example.com/c.xml" TargetMode="External"/>',
    );
    expect(() => patchDocx(external, [replace({ comment: "c" })], OPTS)).toThrow(
      expect.objectContaining({ code: "OOXML_INVALID" }),
    );
    const elsewhere = fixture({
      edit: (parts) => {
        parts["_rels/.rels"] = (parts["_rels/.rels"] as string).replace(
          'Target="word/document.xml"',
          'Target="word/main.xml"',
        );
        parts["word/main.xml"] = parts["word/document.xml"] as string;
      },
    });
    expect(readDocx(elsewhere).paragraphs).toHaveLength(10);
    expect(() => patchDocx(elsewhere, [replace()], OPTS)).toThrow(
      expect.objectContaining({ code: "OOXML_INVALID" }),
    );
  });

  it("checks the namespace of each part it rewrites", () => {
    const wrongSettings = fixture({
      edit: (parts) =>
        void (parts["word/settings.xml"] =
          `${HEAD}<w:settings xmlns:w="urn:not-word"><w:zoom w:percent="100"/></w:settings>`),
    });
    expect(() => patchDocx(wrongSettings, [replace()], OPTS)).toThrow(
      expect.objectContaining({ code: "OOXML_INVALID" }),
    );
    const wrongRels = fixture({
      edit: (parts) =>
        void (parts["word/_rels/document.xml.rels"] = (
          parts["word/_rels/document.xml.rels"] as string
        ).replace("package/2006/relationships", "package/2006/other")),
    });
    expect(() => patchDocx(wrongRels, [replace()], OPTS)).toThrow(
      expect.objectContaining({ code: "OOXML_INVALID" }),
    );
  });

  it("reads UTF-16 parts and writes them back as UTF-8", () => {
    const bytes = fixture({
      edit: (parts) => {
        const xml = parts["word/document.xml"] as string;
        parts["word/document.xml"] = utf16(xml.replace('encoding="UTF-8"', 'encoding="UTF-16"'));
      },
    });
    expect(readDocx(bytes).paragraphs[3]?.text).toContain("The Supplier shall");
    const out = part(patchDocx(bytes, [replace()], OPTS).bytes, "word/document.xml");
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"')).toBe(true);
    expect(readDocx(patchDocx(bytes, [replace()], OPTS).bytes).paragraphs[3]?.text).toContain(
      "The Vendor shall",
    );
  });
});

describe("paragraphFragment", () => {
  it("wraps one patched paragraph in a Flat OPC package for insertOoxml", () => {
    const ooxml = paragraphFragment(fixture(), replace({ comment: "left out" }), OPTS);
    const doc = parse(ooxml);
    const pkg = doc.documentElement;
    expect(pkg?.localName).toBe("package");
    const names = Array.from(
      doc.getElementsByTagNameNS("http://schemas.microsoft.com/office/2006/xmlPackage", "part"),
    ).map((p) => (p as Element).getAttribute("pkg:name"));
    expect(names).toEqual(["/_rels/.rels", "/word/document.xml"]);
    expect(all(doc, "p")).toHaveLength(1);
    expect(all(doc, "del")).toHaveLength(1);
    expect(all(doc, "ins")).toHaveLength(1);
    expect(all(doc, "commentRangeStart")).toHaveLength(0);
    expect(ooxml).toContain(NUMBERED_PPR);
    expect(ooxml).toContain('xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"');
  });

  it("returns only the new paragraph for insert_after and throws on failure", () => {
    const ooxml = paragraphFragment(
      fixture(),
      { id: "n", kind: "insert_after", paragraph_index: 6, before: "Cell B", after: "Cell C" },
      OPTS,
    );
    expect(all(parse(ooxml), "p")).toHaveLength(1);
    expect(all(parse(ooxml), "p")[0]?.textContent).toBe("Cell C");
    expect(() => paragraphFragment(fixture(), replace({ before: "nope" }), OPTS)).toThrow(
      expect.objectContaining({ code: "ANCHOR_FAILED" }),
    );
  });
});

const soffice = (() => {
  try {
    return execFileSync("which", ["soffice"]).toString().trim() || null;
  } catch {
    return null;
  }
})();

describe.skipIf(!soffice)("LibreOffice", () => {
  it("converts a patched document to PDF", () => {
    const result = patchDocx(
      fixture(),
      [
        replace({ comment: "Rule: say Vendor" }),
        {
          id: "n",
          kind: "insert_after",
          paragraph_index: 3,
          before: "",
          after: "New clause.",
          comment: "Why",
        },
        replace({ id: "c", paragraph_index: 5, before: "Cell A", after: "Cell Z" }),
      ],
      OPTS,
    );
    const dir = mkdtempSync(join(tmpdir(), "docx-patch-"));
    try {
      writeFileSync(join(dir, "patched.docx"), result.bytes);
      execFileSync(
        soffice as string,
        [
          `-env:UserInstallation=file://${join(dir, "profile")}`,
          "--headless",
          "--convert-to",
          "pdf",
          "--outdir",
          dir,
          join(dir, "patched.docx"),
        ],
        { timeout: 120_000, stdio: "pipe" },
      );
      expect(existsSync(join(dir, "patched.pdf"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);
});
