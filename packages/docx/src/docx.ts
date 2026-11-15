import { strToU8, type ZipOptions, zipSync } from "fflate";
import type { Block, BlockKind, Run, TextRun } from "./markdown.js";
import {
  abstractNumXml,
  coreXml,
  footnotesXml,
  numXml,
  PKG_REL,
  R,
  type RawRun,
  runXml,
  STYLE_DEFS,
  textXml,
  titleXml,
  W,
} from "./parts.js";
import { packIntoTemplate } from "./template.js";
import { isoSeconds, XML_HEAD, xmlText } from "./xml.js";

export { type RawRun, runXml, textXml };

export interface Revision {
  id: () => number;
  author: string;
  date: string;
}

export const revisionAttrs = (rev: Revision) =>
  `w:id="${rev.id()}" w:author="${xmlText(rev.author)}" w:date="${rev.date}"`;

export const insXml = (runs: readonly RawRun[], rev: Revision) => {
  const body = runs.map((run) => runXml(run)).join("");
  return body ? `<w:ins ${revisionAttrs(rev)}>${body}</w:ins>` : "";
};

export const delXml = (runs: readonly RawRun[], rev: Revision) => {
  const body = runs.map((run) => runXml(run, true)).join("");
  return body ? `<w:del ${revisionAttrs(rev)}>${body}</w:del>` : "";
};

const STYLE: Partial<Record<BlockKind, string>> = {
  heading1: "Heading1",
  heading2: "Heading2",
  heading3: "Heading3",
  bullet: "ListParagraph",
  numbered: "ListParagraph",
};

/** Gives each unbroken list its own numbering, so a second list starts again at 1. */
export class Lists {
  readonly nums: { id: number; abstract: 0 | 1 }[] = [];
  private previous: BlockKind | null = null;

  numId(kind: BlockKind): number | null {
    const list = kind === "bullet" || kind === "numbered";
    if (list && kind !== this.previous) {
      this.nums.push({ id: this.nums.length + 1, abstract: kind === "bullet" ? 0 : 1 });
    }
    this.previous = kind;
    return list ? this.nums.length : null;
  }
}

/** Paragraph properties; `mark` revises the paragraph mark, `changedFrom` its style. */
export function pPrXml(
  kind: BlockKind,
  numId: number | null,
  extra: { mark?: string; changedFrom?: string } = {},
): string {
  const style = STYLE[kind];
  const inner = [
    style ? `<w:pStyle w:val="${style}"/>` : "",
    numId === null ? "" : `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`,
    extra.mark ? `<w:rPr>${extra.mark}</w:rPr>` : "",
    extra.changedFrom ?? "",
  ].join("");
  return inner ? `<w:pPr>${inner}</w:pPr>` : "";
}

/** The style a paragraph had before; list numbering isn't carried, only the style. */
export function oldPPr(kind: BlockKind, rev: Revision): string {
  const style = STYLE[kind];
  const inner = style ? `<w:pStyle w:val="${style}"/>` : "";
  return `<w:pPrChange ${revisionAttrs(rev)}><w:pPr>${inner}</w:pPr></w:pPrChange>`;
}

export const markXml = (type: "ins" | "del", rev: Revision) => `<w:${type} ${revisionAttrs(rev)}/>`;

export interface PackageInput {
  title?: string;
  author: string;
  date: Date | string;
  /** Paragraph XML, in order. */
  paragraphs: readonly string[];
  lists: Lists;
  footnotes?: readonly string[];
  trackRevisions?: boolean;
  /** A firm's .docx or .dotx: its styles, headers, footers, numbering and page setup are kept. */
  template?: Uint8Array;
}

function documentXml(input: PackageInput): string {
  const title = input.title ? titleXml(input.title) : "";
  // A4 with 2.54 cm margins.
  const section =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';
  return `${XML_HEAD}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${title}${input.paragraphs.join("")}${section}</w:body></w:document>`;
}

const STYLES = `${XML_HEAD}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-AU"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${Object.values(STYLE_DEFS).join("")}</w:styles>`;

function numberingXml(lists: Lists): string {
  const nums = lists.nums.map((num) => numXml(num.id, num.abstract)).join("");
  return `${XML_HEAD}<w:numbering xmlns:w="${W}">${abstractNumXml(0, 0)}${abstractNumXml(1, 1)}${nums}</w:numbering>`;
}

function settingsXml(input: PackageInput): string {
  // Element order is fixed by the schema; Word rejects it shuffled.
  return `${XML_HEAD}<w:settings xmlns:w="${W}"><w:zoom w:percent="100"/>${input.trackRevisions ? "<w:trackRevisions/>" : ""}<w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>${input.footnotes?.length ? '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>' : ""}<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
}

const rel = (id: string, type: string, target: string) =>
  `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`;

/** Zips the parts of a Word document. Same input, same bytes. */
export function pack(input: PackageInput): Uint8Array {
  if (input.template) return packIntoTemplate(input.template, input);
  const date = isoSeconds(input.date);
  const footnotes = Boolean(input.footnotes?.length);
  const override = (part: string, type: string) =>
    `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`;
  const parts: Record<string, string> = {
    "[Content_Types].xml": `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${override("/word/document.xml", "wordprocessingml.document.main+xml")}${override("/word/styles.xml", "wordprocessingml.styles+xml")}${override("/word/settings.xml", "wordprocessingml.settings+xml")}${override("/word/numbering.xml", "wordprocessingml.numbering+xml")}${footnotes ? override("/word/footnotes.xml", "wordprocessingml.footnotes+xml") : ""}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${override("/docProps/app.xml", "extended-properties+xml")}</Types>`,
    "_rels/.rels": `${XML_HEAD}<Relationships xmlns="${PKG_REL}">${rel("rId1", "officeDocument", "word/document.xml")}<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>${rel("rId3", "extended-properties", "docProps/app.xml")}</Relationships>`,
    "word/document.xml": documentXml(input),
    "word/_rels/document.xml.rels": `${XML_HEAD}<Relationships xmlns="${PKG_REL}">${rel("rId1", "styles", "styles.xml")}${rel("rId2", "settings", "settings.xml")}${rel("rId3", "numbering", "numbering.xml")}${footnotes ? rel("rId4", "footnotes", "footnotes.xml") : ""}</Relationships>`,
    "word/styles.xml": STYLES,
    "word/settings.xml": settingsXml(input),
    "word/numbering.xml": numberingXml(input.lists),
    "docProps/core.xml": coreXml(input.title, input.author, date),
    "docProps/app.xml": `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>LegalLabs</Application></Properties>`,
  };
  if (footnotes) parts["word/footnotes.xml"] = footnotesXml(input.footnotes ?? []);
  const mtime = new Date(date);
  const files = Object.fromEntries(
    Object.entries(parts).map(([name, xml]) => [
      name,
      [strToU8(xml), { mtime }] satisfies [Uint8Array, ZipOptions],
    ]),
  );
  return zipSync(files, { level: 6 });
}

export interface DocxInput {
  title?: string;
  blocks: readonly Block[];
  author: string;
  date: Date | string;
  /** Footnote texts; a `{ footnote: n }` run points at the nth, from 1. */
  footnotes?: readonly string[];
  template?: Uint8Array;
}

export function buildDocx(input: DocxInput): Uint8Array {
  isoSeconds(input.date);
  const count = input.footnotes?.length ?? 0;
  for (const block of input.blocks) {
    for (const run of block.runs) {
      // A reference to a missing note makes Word report the file as corrupt.
      if (
        "footnote" in run &&
        !(Number.isInteger(run.footnote) && run.footnote >= 1 && run.footnote <= count)
      ) {
        throw new RangeError(`footnote ${run.footnote} does not exist`);
      }
    }
  }
  const lists = new Lists();
  const paragraphs = input.blocks.map(
    (block) =>
      `<w:p>${pPrXml(block.kind, lists.numId(block.kind))}${block.runs.map((run) => runXml(run)).join("")}</w:p>`,
  );
  return pack({ ...input, paragraphs, lists });
}

/** A citation as a footnote: `Document, p. X: "quote"`. */
export const citationFootnote = (citation: {
  document: string;
  page?: number | null;
  quote: string;
}) => `${citation.document}${citation.page ? `, p. ${citation.page}` : ""}: "${citation.quote}"`;
