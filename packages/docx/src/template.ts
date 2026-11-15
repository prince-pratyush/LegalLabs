import { strFromU8, strToU8, type Unzipped, unzipSync, type ZipOptions, zipSync } from "fflate";
import type { PackageInput } from "./docx.js";
import {
  abstractNumXml,
  coreXml,
  footnotesXml,
  numXml,
  PKG_REL,
  R,
  STYLE_DEFS,
  titleXml,
  W,
} from "./parts.js";
import { isoSeconds, XML_HEAD, xmlText } from "./xml.js";

const OFFICE_DOC = `${R}/officeDocument`;
const MAIN_DOC = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const MAIN_TEMPLATE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml";
// A template is a few MB; this much unpacked means a zip bomb, not a letterhead.
const MAX_UNPACKED = 100 * 1024 * 1024;

/** Marks in a template: the draft goes where `{{content}}` is, its title where `{{title}}` is. */
export const CONTENT_MARK = "{{content}}";
export const TITLE_MARK = "{{title}}";

export type TemplateProblem = "NOT_DOCX" | "MACROS" | "STRICT" | "TOO_LARGE";

export class TemplateError extends Error {
  constructor(readonly problem: TemplateProblem) {
    super(`unusable template: ${problem}`);
    this.name = "TemplateError";
  }
}

export interface TemplateParts {
  files: Unzipped;
  /** e.g. `word/document.xml` */
  main: string;
  /** The folder the main part is in, with a trailing slash. */
  dir: string;
  relsPath: string;
}

const attr = (tag: string, name: string) =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

export const partText = (files: Unzipped, path: string) => {
  const data = files[path];
  return data ? strFromU8(data) : null;
};

/** Unpacks and checks a template; throws `TemplateError` for anything we can't safely fill. */
export function openTemplate(bytes: Uint8Array): TemplateParts {
  let files: Unzipped;
  try {
    let total = 0;
    files = unzipSync(bytes, {
      filter: (file) => {
        total += file.originalSize;
        if (total > MAX_UNPACKED) throw new TemplateError("TOO_LARGE");
        return true;
      },
    });
  } catch (err) {
    if (err instanceof TemplateError) throw err;
    throw new TemplateError("NOT_DOCX");
  }
  const types = partText(files, "[Content_Types].xml");
  const rels = partText(files, "_rels/.rels");
  if (!types || !rels) throw new TemplateError("NOT_DOCX");
  // Macros never ride along into a document we hand out.
  if (/macroEnabled/i.test(types) || Object.keys(files).some((n) => /vbaProject/i.test(n))) {
    throw new TemplateError("MACROS");
  }
  const target = relsOf(rels).find((r) => r.type === OFFICE_DOC);
  const main = target?.target.replace(/^\//, "");
  if (!main || !files[main]) throw new TemplateError("NOT_DOCX");
  const doc = strFromU8(files[main]);
  if (doc.includes("purl.oclc.org/ooxml")) throw new TemplateError("STRICT");
  if (!doc.includes(`xmlns:w="${W}"`) || !/<w:body\b/.test(doc)) {
    throw new TemplateError("NOT_DOCX");
  }
  const dir = main.includes("/") ? main.slice(0, main.lastIndexOf("/") + 1) : "";
  return { files, main, dir, relsPath: `${dir}_rels/${main.slice(dir.length)}.rels` };
}

export interface Rel {
  id: string;
  type: string;
  target: string;
}

export const relsOf = (xml: string | null): Rel[] =>
  xml
    ? [...xml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => ({
        id: attr(m[0], "Id") ?? "",
        type: attr(m[0], "Type") ?? "",
        target: attr(m[0], "Target") ?? "",
      }))
    : [];

/** The part a relationship of `type` (e.g. "styles") from the main document points at. */
export function relatedPart(t: TemplateParts, type: string): string | null {
  const found = relsOf(partText(t.files, t.relsPath)).find((r) => r.type === `${R}/${type}`);
  if (!found) return null;
  return found.target.startsWith("/") ? found.target.slice(1) : `${t.dir}${found.target}`;
}

const unescapeXml = (s: string) =>
  s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

const PARAGRAPH = /<w:p\b[^>]*?(?:\/>|>[\s\S]*?<\/w:p>)/g;

/** The plain text of one paragraph's runs. */
export const paragraphText = (para: string) =>
  [...para.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
    .map((t) => unescapeXml(t[1] ?? ""))
    .join("");

/** The text of each paragraph in a part. */
export const paragraphTexts = (xml: string): string[] =>
  [...xml.matchAll(PARAGRAPH)].map((m) => paragraphText(m[0]));

const PLACEHOLDER = /\{\{[^{}\n]{1,60}\}\}|\[INSERT[^\]\n]{0,80}\]|\[●\]|\[_{2,}\]/gi;

/** Fill-in spots a lawyer left in the template, like `{{Counterparty}}` or `[INSERT DATE]`. */
export function placeholders(bytes: Uint8Array): string[] {
  const t = openTemplate(bytes);
  const parts = [
    t.main,
    ...Object.keys(t.files).filter((n) => /(^|\/)(header|footer)\d*\.xml$/.test(n)),
  ];
  const found = new Set<string>();
  for (const part of parts) {
    for (const para of paragraphTexts(partText(t.files, part) ?? "")) {
      for (const m of para.matchAll(PLACEHOLDER)) {
        const mark = m[0].replace(/\s+/g, " ");
        if (mark !== CONTENT_MARK && mark !== TITLE_MARK) found.add(mark);
      }
    }
  }
  return [...found].slice(0, 200);
}

export interface StyleInfo {
  id: string;
  type: string;
  /** Lower case, as Word stores built-in names. */
  name: string;
  xml: string;
}

export const stylesOf = (xml: string): StyleInfo[] =>
  [...xml.matchAll(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g)].map((m) => {
    const open = /<w:style\b[^>]*>/.exec(m[0])?.[0] ?? "";
    return {
      id: attr(open, "w:styleId") ?? "",
      type: attr(open, "w:type") ?? "",
      name: (/<w:name w:val="([^"]*)"/.exec(m[0])?.[1] ?? "").toLowerCase(),
      xml: m[0],
    };
  });

// Built-in names are fixed; the ids differ by the language Word was set to.
export const BUILT_IN_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(STYLE_DEFS).map(([id, xml]) => [
    id,
    (/<w:name w:val="([^"]+)"/.exec(xml)?.[1] ?? id).toLowerCase(),
  ]),
);

/** Inserts `piece` before the first of `successors` found, keeping the schema's order. */
function insertBefore(xml: string, successors: readonly string[], close: string, piece: string) {
  let at = xml.lastIndexOf(close);
  for (const tag of successors) {
    const i = xml.search(new RegExp(`<${tag}[\\s/>]`));
    if (i !== -1 && i < at) at = i;
  }
  return at === -1 ? xml : `${xml.slice(0, at)}${piece}${xml.slice(at)}`;
}

// What may follow trackRevisions and footnotePr in w:settings (ECMA-376 CT_Settings).
const AFTER_TRACK = [
  "w:doNotTrackMoves",
  "w:doNotTrackFormatting",
  "w:documentProtection",
  "w:autoFormatOverride",
  "w:styleLockTheme",
  "w:styleLockQFSet",
  "w:defaultTabStop",
  "w:autoHyphenation",
  "w:evenAndOddHeaders",
  "w:characterSpacingControl",
  "w:footnotePr",
  "w:endnotePr",
  "w:compat",
  "w:rsids",
];
const AFTER_FOOTNOTE_PR = [
  "w:endnotePr",
  "w:compat",
  "w:docVars",
  "w:rsids",
  "m:mathPr",
  "w:themeFontLang",
  "w:clrSchemeMapping",
  "w:decimalSymbol",
  "w:listSeparator",
];

const maxOf = (xml: string, re: RegExp) =>
  Math.max(0, ...[...xml.matchAll(re)].map((m) => Number(m[1])).filter(Number.isFinite));

/**
 * Pours generated paragraphs into a firm's template. Its styles, headers, footers,
 * numbering, theme and page setup are kept. Its body is replaced, or only its
 * `{{content}}` paragraph when it has one, so a cover page or letterhead block stays.
 */
export function packIntoTemplate(bytes: Uint8Array, input: PackageInput): Uint8Array {
  const date = isoSeconds(input.date);
  const t = openTemplate(bytes);
  const files: Record<string, string | Uint8Array> = { ...t.files };
  let types = partText(t.files, "[Content_Types].xml") ?? "";
  let docRels =
    partText(t.files, t.relsPath) ??
    `${XML_HEAD}<Relationships xmlns="${PKG_REL}"></Relationships>`;
  const relIds = new Set(relsOf(docRels).map((r) => r.id));
  const addPart = (name: string, relType: string, contentType: string, xml: string) => {
    let n = relIds.size + 1;
    while (relIds.has(`rId${n}`)) n++;
    relIds.add(`rId${n}`);
    files[`${t.dir}${name}`] = xml;
    docRels = docRels.replace(
      "</Relationships>",
      `<Relationship Id="rId${n}" Type="${R}/${relType}" Target="${name}"/></Relationships>`,
    );
    types = types.replace(
      "</Types>",
      `<Override PartName="/${t.dir}${name}" ContentType="application/vnd.openxmlformats-officedocument.${contentType}"/></Types>`,
    );
  };

  // Styles: each of ours maps to the template's style with the same built-in name.
  const stylesPath = relatedPart(t, "styles");
  let stylesXml = (stylesPath && partText(t.files, stylesPath)) || null;
  const styles = stylesXml ? stylesOf(stylesXml) : [];
  const styleMap = new Map<string, string>();
  const borrowed: string[] = [];
  const styleFor = (ours: string): string => {
    const known = styleMap.get(ours);
    if (known) return known;
    const name = BUILT_IN_NAMES[ours];
    const found = styles.find((s) => s.name === name) ?? styles.find((s) => s.id === ours);
    const id = found?.id ?? ours;
    if (!found && STYLE_DEFS[ours]) borrowed.push(STYLE_DEFS[ours]);
    styleMap.set(ours, id);
    return id;
  };
  const restyle = (xml: string) =>
    xml.replace(
      /<w:(pStyle|rStyle) w:val="([^"]+)"\/>/g,
      (_, tag: string, id: string) =>
        `<w:${tag} w:val="${BUILT_IN_NAMES[id] ? styleFor(id) : id}"/>`,
    );

  // Lists: the firm's List Bullet / List Number styles carry its numbering, so we use them.
  const numberingPath = relatedPart(t, "numbering");
  let numberingXml = (numberingPath && partText(t.files, numberingPath)) || null;
  const maxAbstract = numberingXml ? maxOf(numberingXml, /w:abstractNumId="(\d+)"/g) : -1;
  const maxNum = numberingXml ? maxOf(numberingXml, /<w:num\b[^>]*w:numId="(\d+)"/g) : 0;
  const firmList = (name: string) => {
    const style = styles.find((s) => s.type === "paragraph" && s.name === name);
    const numId = style && /<w:numId w:val="(\d+)"/.exec(style.xml)?.[1];
    if (!style || !numId || !numberingXml) return null;
    const num = new RegExp(`<w:num\\b[^>]*w:numId="${numId}"[^>]*>[\\s\\S]*?</w:num>`).exec(
      numberingXml,
    )?.[0];
    const abstract = num && /<w:abstractNumId w:val="(\d+)"/.exec(num)?.[1];
    return abstract ? { styleId: style.id, abstract: Number(abstract) } : null;
  };
  const firm = [firmList("list bullet"), firmList("list number")] as const;
  const kinds = new Map(input.lists.nums.map((n) => [n.id, n.abstract]));
  const ownAbstract = (kind: 0 | 1) => maxAbstract + 1 + kind;
  if (input.lists.nums.length > 0) {
    const kindsUsed = new Set(input.lists.nums.map((n) => n.abstract));
    const abstracts = [...kindsUsed]
      .filter((kind) => !firm[kind])
      .map((kind) => abstractNumXml(ownAbstract(kind), kind))
      .join("");
    const nums = input.lists.nums
      .map((n) => numXml(maxNum + n.id, firm[n.abstract]?.abstract ?? ownAbstract(n.abstract)))
      .join("");
    if (numberingXml && numberingPath) {
      numberingXml = insertBefore(
        numberingXml,
        ["w:num", "w:numIdMacAtCleanup"],
        "</w:numbering>",
        abstracts,
      );
      numberingXml = insertBefore(numberingXml, ["w:numIdMacAtCleanup"], "</w:numbering>", nums);
      files[numberingPath] = numberingXml;
    } else {
      addPart(
        "numbering.xml",
        "numbering",
        "wordprocessingml.numbering+xml",
        `${XML_HEAD}<w:numbering xmlns:w="${W}">${abstracts}${nums}</w:numbering>`,
      );
    }
  }

  // Footnotes: ours are numbered after any the template already has.
  const footnotesPath = relatedPart(t, "footnotes");
  const firmNotes = (footnotesPath && partText(t.files, footnotesPath)) || null;
  const noteOffset = firmNotes ? maxOf(firmNotes, /<w:footnote\b[^>]*w:id="(\d+)"/g) : 0;
  if (input.footnotes?.length) {
    const ours = restyle(footnotesXml(input.footnotes));
    if (firmNotes && footnotesPath) {
      const notes = [...ours.matchAll(/<w:footnote w:id="(\d+)">[\s\S]*?<\/w:footnote>/g)]
        .map((m) => m[0].replace(/w:id="(\d+)"/, (_, id) => `w:id="${Number(id) + noteOffset}"`))
        .join("");
      files[footnotesPath] = firmNotes.replace("</w:footnotes>", `${notes}</w:footnotes>`);
    } else {
      addPart("footnotes.xml", "footnotes", "wordprocessingml.footnotes+xml", ours);
    }
  }

  const content = input.paragraphs.map((p) => {
    let out = p;
    const numId = /<w:numId w:val="(\d+)"\/>/.exec(p)?.[1];
    if (numId) {
      const list = firm[kinds.get(Number(numId)) ?? 0];
      out = out.replace(
        /<w:numId w:val="(\d+)"\/>/,
        (_, id) => `<w:numId w:val="${maxNum + Number(id)}"/>`,
      );
      // Only the paragraph's own style; a tracked change's old style keeps the plain one.
      if (list)
        out = out.replace(
          '<w:pStyle w:val="ListParagraph"/>',
          `<w:pStyle w:val="${list.styleId}"/>`,
        );
    }
    if (noteOffset) {
      out = out.replace(
        /<w:footnoteReference w:id="(\d+)"\/>/g,
        (_, id) => `<w:footnoteReference w:id="${Number(id) + noteOffset}"/>`,
      );
    }
    return restyle(out);
  });

  // Body: the draft replaces `{{content}}`, or the whole body; the last section's setup
  // (page size, margins, header and footer references) always stays.
  let doc = partText(t.files, t.main) ?? "";
  const open = /<w:body\b[^>]*>/.exec(doc);
  const close = doc.lastIndexOf("</w:body>");
  if (!open || close === -1) throw new TemplateError("NOT_DOCX");
  const start = open.index + open[0].length;
  const body = doc.slice(start, close);
  const sectAt = body.lastIndexOf("<w:sectPr");
  const section = sectAt === -1 ? "" : body.slice(sectAt);
  let titled = false;
  let placed = false;
  const SLOT = "\u0000DRAFT\u0000";
  const kept = (sectAt === -1 ? body : body.slice(0, sectAt)).replace(PARAGRAPH, (para) => {
    const words = paragraphText(para).trim();
    if (words === CONTENT_MARK && !placed) {
      placed = true;
      return SLOT;
    }
    if (words === TITLE_MARK) {
      titled = true;
      // The title takes the mark's own formatting.
      const pPr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(para)?.[0] ?? "";
      const rPr = /<w:r\b[^>]*>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/.exec(para)?.[1] ?? "";
      const run = input.title
        ? `<w:r>${rPr}<w:t xml:space="preserve">${xmlText(input.title)}</w:t></w:r>`
        : "";
      return `<w:p>${pPr}${run}</w:p>`;
    }
    return para;
  });
  const title = input.title && !titled ? restyle(titleXml(input.title)) : "";
  const draft = `${title}${content.join("")}`;
  const filled = placed ? kept.replace(SLOT, () => draft) : draft;
  doc = `${doc.slice(0, start)}${filled}${section}${doc.slice(close)}`;
  files[t.main] = doc;

  if (borrowed.length || !stylesXml) {
    stylesXml = (stylesXml ?? `${XML_HEAD}<w:styles xmlns:w="${W}"></w:styles>`).replace(
      "</w:styles>",
      `${borrowed.join("")}</w:styles>`,
    );
    if (stylesPath) files[stylesPath] = stylesXml;
    else addPart("styles.xml", "styles", "wordprocessingml.styles+xml", stylesXml);
  }

  // Settings: tracked changes stay on, and new footnotes have their separators declared.
  const settingsPath = relatedPart(t, "settings");
  let settings = (settingsPath && partText(t.files, settingsPath)) || null;
  if (settings && settingsPath) {
    if (input.trackRevisions && !/<w:trackRevisions[\s/>]/.test(settings)) {
      settings = insertBefore(settings, AFTER_TRACK, "</w:settings>", "<w:trackRevisions/>");
    }
    if (input.footnotes?.length && !firmNotes && !/<w:footnotePr[\s>]/.test(settings)) {
      settings = insertBefore(
        settings,
        AFTER_FOOTNOTE_PR,
        "</w:settings>",
        '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>',
      );
    }
    files[settingsPath] = settings;
  }

  // A .dotx is saved as a document: Word refuses a template type inside a .docx.
  types = types.replace(MAIN_TEMPLATE, MAIN_DOC);
  // Our author and dates replace the template's.
  files["docProps/core.xml"] = coreXml(input.title, input.author, date);
  if (!types.includes('PartName="/docProps/core.xml"')) {
    types = types.replace(
      "</Types>",
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
    );
    files["_rels/.rels"] = (partText(t.files, "_rels/.rels") ?? "").replace(
      "</Relationships>",
      '<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
    );
  }
  files["[Content_Types].xml"] = types;
  files[t.relsPath] = docRels;

  const mtime = new Date(date);
  const zipped = Object.fromEntries(
    Object.entries(files).map(([name, data]) => [
      name,
      [typeof data === "string" ? strToU8(data) : data, { mtime }] satisfies [
        Uint8Array,
        ZipOptions,
      ],
    ]),
  );
  return zipSync(zipped, { level: 6 });
}
