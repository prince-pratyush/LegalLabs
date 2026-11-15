import type { Run, TextRun } from "./markdown.js";
import { XML_HEAD, xmlText } from "./xml.js";

// Pieces of a Word package that plain exports and template exports share.
export const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

export function textXml(text: string, tag: "w:t" | "w:delText"): string {
  // Tabs and breaks are their own elements; a literal tab or newline inside w:t is lost.
  return text
    .split("\n")
    .map((line) =>
      line
        .split("\t")
        .map((part) => (part ? `<${tag} xml:space="preserve">${xmlText(part)}</${tag}>` : ""))
        .join("<w:tab/>"),
    )
    .join("<w:br/>");
}

/** A text run whose formatting is a whole `w:rPr` element copied from an existing document. */
export type RawRun = TextRun & { rPr?: string };

export function runXml(run: Run | RawRun, deleted = false): string {
  if ("footnote" in run) {
    return `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${run.footnote}"/></w:r>`;
  }
  const body = textXml(run.text, deleted ? "w:delText" : "w:t");
  if (!body) return "";
  if ("rPr" in run && run.rPr !== undefined) return `<w:r>${run.rPr}${body}</w:r>`;
  const props = `${run.bold ? "<w:b/>" : ""}${run.italic ? "<w:i/>" : ""}`;
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${body}</w:r>`;
}

export const titleXml = (title: string) =>
  `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${runXml({ text: title })}</w:p>`;

const heading = (id: string, name: string, size: number, level: number) =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${level}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;

/** Our paragraph and character styles by id, so a firm template can borrow the ones it lacks. */
export const STYLE_DEFS: Record<string, string> = {
  Normal:
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>',
  Title:
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:sz w:val="48"/></w:rPr></w:style>',
  Heading1: heading("Heading1", "heading 1", 32, 0),
  Heading2: heading("Heading2", "heading 2", 28, 1),
  Heading3: heading("Heading3", "heading 3", 24, 2),
  ListParagraph:
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>',
  FootnoteText:
    '<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>',
  FootnoteReference:
    '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>',
};

const level = (format: "bullet" | "decimal", text: string) =>
  `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>`;

/** Our list formats: abstract 0 is bullets, 1 is numbers. */
export const abstractNumXml = (id: number, abstract: 0 | 1) =>
  `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="singleLevel"/>${abstract === 0 ? level("bullet", "•") : level("decimal", "%1.")}</w:abstractNum>`;

/** A list instance that restarts at 1. */
export const numXml = (id: number, abstractId: number) =>
  `<w:num w:numId="${id}"><w:abstractNumId w:val="${abstractId}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`;

export const separator = (type: string, id: number, mark: string) =>
  `<w:footnote w:type="${type}" w:id="${id}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:${mark}/></w:r></w:p></w:footnote>`;

export function footnotesXml(footnotes: readonly string[]): string {
  const notes = footnotes
    .map(
      (text, i) =>
        `<w:footnote w:id="${i + 1}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>${runXml({ text: ` ${text}` })}</w:p></w:footnote>`,
    )
    .join("");
  return `${XML_HEAD}<w:footnotes xmlns:w="${W}" xmlns:r="${R}">${separator("separator", -1, "separator")}${separator("continuationSeparator", 0, "continuationSeparator")}${notes}</w:footnotes>`;
}

export const coreXml = (title: string | undefined, author: string, date: string) =>
  `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${title ? `<dc:title>${xmlText(title)}</dc:title>` : ""}<dc:creator>${xmlText(author)}</dc:creator><cp:lastModifiedBy>${xmlText(author)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${date}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${date}</dcterms:modified></cp:coreProperties>`;
