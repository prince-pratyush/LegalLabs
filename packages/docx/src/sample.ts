import { strToU8, type ZipOptions, zipSync } from "fflate";
import { PKG_REL, R, W } from "./parts.js";
import { XML_HEAD } from "./xml.js";

const CT = "application/vnd.openxmlformats-officedocument.wordprocessingml";

export interface SampleTemplateOptions {
  /** Put `{{title}}` and `{{content}}` marks in the body; without them the body is replaced. */
  marks?: boolean;
  /** Save as a .dotx (template content type). */
  dotx?: boolean;
  firmName?: string;
}

const p = (text: string, style?: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

/**
 * A small firm template made by hand: Georgia text, style ids that aren't Word's English
 * ones, a lettered "List Number" scheme, a header, a footer with a page number and US
 * Letter paper. Every choice differs from our defaults, so a test can tell whose won.
 */
export function sampleFirmTemplate(options: SampleTemplateOptions = {}): Uint8Array {
  const firm = options.firmName ?? "Example Partners";
  const body = options.marks
    ? `${p(`${firm} · Level 9, 1 Example Street`, "FirmLetterhead")}${p("{{title}}", "FirmTitle")}${p("{{content}}")}${p("Signed for {{Counterparty}} on [INSERT DATE]")}`
    : p("Sample body text that the draft replaces.");
  const style = (type: string, id: string, name: string, inner: string) =>
    `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/>${inner}</w:style>`;
  const parts: Record<string, string> = {
    "[Content_Types].xml": `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${CT}.${options.dotx ? "template" : "document"}.main+xml"/><Override PartName="/word/styles.xml" ContentType="${CT}.styles+xml"/><Override PartName="/word/settings.xml" ContentType="${CT}.settings+xml"/><Override PartName="/word/numbering.xml" ContentType="${CT}.numbering+xml"/><Override PartName="/word/header1.xml" ContentType="${CT}.header+xml"/><Override PartName="/word/footer1.xml" ContentType="${CT}.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    "_rels/.rels": `${XML_HEAD}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `${XML_HEAD}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R}/settings" Target="settings.xml"/><Relationship Id="rId3" Type="${R}/numbering" Target="numbering.xml"/><Relationship Id="rId7" Type="${R}/header" Target="header1.xml"/><Relationship Id="rId8" Type="${R}/footer" Target="footer1.xml"/></Relationships>`,
    "word/document.xml": `${XML_HEAD}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}<w:sectPr><w:headerReference w:type="default" r:id="rId7"/><w:footerReference w:type="default" r:id="rId8"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1800" w:right="1440" w:bottom="1800" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    "word/styles.xml": `${XML_HEAD}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia" w:eastAsia="Georgia"/><w:sz w:val="23"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault></w:docDefaults>${style("paragraph", "Normal", "Normal", '<w:qFormat/><w:pPr><w:spacing w:after="200"/></w:pPr>')}${style("paragraph", "FirmTitle", "Title", '<w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:caps/><w:sz w:val="36"/></w:rPr>')}${style("paragraph", "FirmHeading1", "heading 1", '<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="30"/></w:rPr>')}${style("paragraph", "FirmHeading2", "heading 2", '<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr>')}${style("paragraph", "FirmListNumber", "List Number", '<w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="5"/></w:numPr><w:ind w:left="567" w:hanging="567"/></w:pPr>')}${style("paragraph", "FirmLetterhead", "Firm Letterhead", '<w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="right"/></w:pPr><w:rPr><w:sz w:val="16"/></w:rPr>')}</w:styles>`,
    "word/settings.xml": `${XML_HEAD}<w:settings xmlns:w="${W}"><w:zoom w:percent="110"/><w:defaultTabStop w:val="567"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`,
    "word/numbering.xml": `${XML_HEAD}<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="3"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%1)"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="567" w:hanging="567"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="3"/></w:num></w:numbering>`,
    "word/header1.xml": `${XML_HEAD}<w:hdr xmlns:w="${W}" xmlns:r="${R}"><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t xml:space="preserve">${firm} · Confidential</w:t></w:r></w:p></w:hdr>`,
    "word/footer1.xml": `${XML_HEAD}<w:ftr xmlns:w="${W}" xmlns:r="${R}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`,
    "docProps/core.xml": `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Template author</dc:creator></cp:coreProperties>`,
  };
  const mtime = new Date("2026-01-01T00:00:00Z");
  return zipSync(
    Object.fromEntries(
      Object.entries(parts).map(([name, xml]) => [
        name,
        [strToU8(xml), { mtime }] satisfies [Uint8Array, ZipOptions],
      ]),
    ),
  );
}
