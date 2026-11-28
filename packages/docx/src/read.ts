import { createHash } from "node:crypto";
import { normaliseParagraph } from "@legallabs/contracts";
import { unzipSync } from "fflate";
import {
  child,
  descendants,
  elements,
  parseXml,
  sourceOf,
  textContent,
  type XmlElement,
  type XmlNode,
} from "./tree.js";

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export interface BodyRun {
  run_index: number;
  char_from: number;
  char_to: number;
  /** sha256 hex of the run's w:rPr as written (of "" when it has none), to spot reformatting. */
  rPr_hash: string;
}

export interface BodyParagraph {
  index: number;
  /** Current text: w:ins counts, w:del and field instructions do not; w:tab is "\t", w:br "\n". */
  text: string;
  section_path?: string;
  style?: string;
  /** sha256 hex of the contract's normaliseParagraph(text), as the Word pane computes it. */
  para_hash: string;
  /** Runs with text, in order, with UTF-16 offsets into `text`. */
  runs: BodyRun[];
  /** Inside a content control, table of contents or text box: never edited. */
  excluded: boolean;
}

export interface ExistingEdit {
  paragraph_index: number;
  kind: "ins" | "del";
  text: string;
  author: string;
  date?: string;
}

export type ExcludedKind =
  | "header"
  | "footer"
  | "footnote"
  | "endnote"
  | "toc"
  | "text_box"
  | "shape"
  | "content_control"
  | "field";

export interface ReadResult {
  paragraphs: BodyParagraph[];
  existingEdits: ExistingEdit[];
  excludedRegions: Record<ExcludedKind, number>;
  /** Paragraph texts plus one paragraph mark each, close to Word's body.text.length. */
  charCount: number;
}

/** Why a span of a paragraph cannot be edited; doubles as the failure code. */
export type Lock = "EXCLUDED_REGION" | "UNSUPPORTED_CONTENT";

export interface RunInfo {
  el: XmlElement;
  rPr: XmlElement | undefined;
  text: string;
  from: number;
  to: number;
}

/** A child of w:p after w:pPr, with the span of paragraph text it carries. */
export interface Item {
  node: XmlNode;
  from: number;
  to: number;
  /** Set for a plain top-level run that may be split and tracked. */
  run?: RunInfo;
  lock?: Lock;
}

export interface Field {
  instr: string;
  toc: boolean;
  nested: boolean;
}

export interface ParagraphModel {
  pPr: XmlElement | undefined;
  text: string;
  items: Item[];
  runs: RunInfo[];
  edits: Omit<ExistingEdit, "paragraph_index">[];
  inToc: boolean;
}

const TOC_INSTR = /^\s*TOC\b/i;
// Run children that are plain text; anything else makes the run opaque.
const PLAIN = new Set(["w:rPr", "w:t", "w:tab", "w:br", "w:cr", "w:lastRenderedPageBreak"]);
const UNSUPPORTED_CONTAINERS = new Set([
  "w:ins",
  "w:hyperlink",
  "w:smartTag",
  "w:customXml",
  "w:moveTo",
  "w:dir",
  "w:bdo",
]);

type RegionCounter = (kind: "toc" | "field" | "content_control") => void;

const isTocSdt = (sdt: XmlElement) => {
  const gallery = [...descendants(child(sdt, "w:sdtPr") ?? sdt)].find(
    (el) => el.name === "w:docPartGallery",
  );
  return /table of contents/i.test(gallery?.attrs["w:val"] ?? "");
};

/**
 * Reads one w:p. `fields` is the complex-field stack at the paragraph's start; it is
 * updated in place, since a field such as a TOC can span many paragraphs.
 */
export function analyseParagraph(
  p: XmlElement,
  src: string,
  fields: Field[],
  count: RegionCounter = () => {},
): ParagraphModel {
  let text = "";
  const runs: RunInfo[] = [];
  const edits: ParagraphModel["edits"] = [];
  let inToc = fields.some((field) => field.toc);

  const visitRun = (r: XmlElement, lock: Lock | undefined) => {
    const from = text.length;
    let inField = fields.length > 0;
    let opaque = false;
    for (const el of elements(r)) {
      if (!PLAIN.has(el.name)) opaque = true;
      if (el.name === "w:t") text += textContent(el, src);
      else if (el.name === "w:tab") text += "\t";
      else if (el.name === "w:br" || el.name === "w:cr") text += "\n";
      else if (el.name === "w:fldChar") {
        inField = true;
        const kind = el.attrs["w:fldCharType"];
        if (kind === "begin") fields.push({ instr: "", toc: false, nested: fields.length > 0 });
        else if (kind === "end") {
          const done = fields.pop();
          if (done && !done.nested) count(done.toc ? "toc" : "field");
        }
      } else if (el.name === "w:instrText") {
        inField = true;
        const top = fields[fields.length - 1];
        if (top) {
          top.instr += textContent(el, src);
          if (TOC_INSTR.test(top.instr)) top.toc = true;
        }
      }
      if (fields.some((field) => field.toc)) inToc = true;
    }
    const info: RunInfo = {
      el: r,
      rPr: child(r, "w:rPr"),
      text: text.slice(from),
      from,
      to: text.length,
    };
    if (info.to > info.from) runs.push(info);
    const runLock: Lock | undefined =
      lock ?? (inField ? "EXCLUDED_REGION" : opaque ? "UNSUPPORTED_CONTENT" : undefined);
    return { info, lock: runLock, plain: !opaque && !inField && lock === undefined };
  };
  /** Walks inline content; returns the strongest lock on text it met. */
  const walk = (nodes: XmlElement[], lock: Lock | undefined): Lock | undefined => {
    let found = lock;
    for (const node of nodes) {
      if (node.name === "w:r") {
        const visited = visitRun(node, lock);
        if (visited.info.to > visited.info.from || visited.lock === "EXCLUDED_REGION") {
          found = strongest(found, visited.lock);
        }
      } else if (node.name === "w:del" || node.name === "w:moveFrom") {
        if (node.name === "w:del") edits.push(editOf(node, "del", deletedText(node, src)));
      } else if (node.name === "w:fldSimple") {
        const toc = TOC_INSTR.test(node.attrs["w:instr"] ?? "");
        if (!fields.length) count(toc ? "toc" : "field");
        if (toc) inToc = true;
        found = strongest(found, walk(elements(node), "EXCLUDED_REGION"));
        found = strongest(found, "EXCLUDED_REGION");
      } else if (node.name === "w:sdt") {
        count(isTocSdt(node) ? "toc" : "content_control");
        const content = child(node, "w:sdtContent");
        if (content) walk(elements(content), "EXCLUDED_REGION");
        found = strongest(found, "EXCLUDED_REGION");
      } else if (UNSUPPORTED_CONTAINERS.has(node.name)) {
        const before = text.length;
        const inner = walk(elements(node), lock ?? "UNSUPPORTED_CONTENT");
        if (node.name === "w:ins") edits.push(editOf(node, "ins", text.slice(before)));
        if (text.length > before) found = strongest(found, inner);
      }
    }
    return found;
  };
  const pPr = child(p, "w:pPr");
  const items: Item[] = [];
  const start = pPr ? p.children.indexOf(pPr) + 1 : 0;
  for (const node of p.children.slice(start)) {
    const from = text.length;
    if (node.type !== "element") {
      items.push({ node, from, to: from });
      continue;
    }
    if (node.name === "w:r") {
      const visited = visitRun(node, undefined);
      items.push({
        node,
        from,
        to: text.length,
        ...(visited.plain ? { run: visited.info } : {}),
        ...(visited.lock ? { lock: visited.lock } : {}),
      });
      continue;
    }
    const lock = walk([node], undefined);
    items.push({ node, from, to: text.length, ...(lock ? { lock } : {}) });
  }
  return { pPr, text, items, runs, edits, inToc };
}

const RANK: Record<Lock, number> = { UNSUPPORTED_CONTENT: 1, EXCLUDED_REGION: 2 };
const strongest = (a: Lock | undefined, b: Lock | undefined) =>
  a === undefined ? b : b === undefined ? a : RANK[a] >= RANK[b] ? a : b;

function deletedText(del: XmlElement, src: string) {
  let text = "";
  for (const el of descendants(del)) {
    if (el.name === "w:delText") text += textContent(el, src);
    else if (el.name === "w:tab") text += "\t";
    else if (el.name === "w:br" || el.name === "w:cr") text += "\n";
  }
  return text;
}

function editOf(el: XmlElement, kind: "ins" | "del", text: string) {
  const date = el.attrs["w:date"];
  return { kind, text, author: el.attrs["w:author"] ?? "", ...(date ? { date } : {}) };
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export const paraHashSync = (text: string) => sha256(normaliseParagraph(text));

export interface Package {
  files: Record<string, Uint8Array>;
  docPath: string;
  relsPath: string;
}

/** Resolves a relationship target against the directory of the part that owns it. */
export function resolveTarget(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = fromPart.split("/").slice(0, -1);
  for (const piece of target.split("/")) {
    if (piece === "..") parts.pop();
    else if (piece !== ".") parts.push(piece);
  }
  return parts.join("/");
}

export interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

export function relationships(xml: string | undefined): Relationship[] {
  if (!xml) return [];
  return elements(parseXml(xml), "Relationship").map((rel) => ({
    id: rel.attrs.Id ?? "",
    type: rel.attrs.Type ?? "",
    target: rel.attrs.Target ?? "",
    external: rel.attrs.TargetMode === "External",
  }));
}

export const relType = (rel: Relationship, name: string) => rel.type.endsWith(`/${name}`);

export type DocxErrorCode = "TOO_LARGE" | "OOXML_INVALID" | "ACTIVE_CONTENT";

/** The file is not a .docx this package can safely read. */
export class DocxError extends Error {
  constructor(
    readonly code: DocxErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const ZIP_LIMITS = {
  entries: 2_000,
  partBytes: 20 * 1024 * 1024,
  totalBytes: 200 * 1024 * 1024,
};

/**
 * Unzips with limits so a zip bomb cannot exhaust memory. fflate inflates each entry
 * into a buffer of the size its header declares and never grows it, so the declared
 * sizes checked here bound what is actually inflated; the totals are checked again
 * on the real output.
 */
export function unzipLimited(bytes: Uint8Array, limits = ZIP_LIMITS): Record<string, Uint8Array> {
  let entries = 0;
  let declared = 0;
  const tooLarge = (what: string) => new DocxError("TOO_LARGE", what);
  const files = unzipSync(bytes, {
    filter: (file) => {
      if (++entries > limits.entries) throw tooLarge(`more than ${limits.entries} zip entries`);
      if (file.originalSize > limits.partBytes) throw tooLarge(`${file.name} is too large`);
      declared += file.originalSize;
      if (declared > limits.totalBytes) throw tooLarge("the unzipped package is too large");
      return true;
    },
  });
  let total = 0;
  for (const [name, data] of Object.entries(files)) {
    if (data.length > limits.partBytes) throw tooLarge(`${name} is too large`);
    total += data.length;
  }
  if (total > limits.totalBytes) throw tooLarge("the unzipped package is too large");
  return files;
}

export function openPackage(bytes: Uint8Array, limits = ZIP_LIMITS): Package {
  const files = unzipLimited(bytes, limits);
  const rootRels = files["_rels/.rels"];
  const main = relationships(rootRels && decodePart(rootRels)).find((rel) =>
    relType(rel, "officeDocument"),
  );
  const docPath = main ? resolveTarget("", main.target) : "word/document.xml";
  if (!files[docPath]) throw new DocxError("OOXML_INVALID", `${docPath} is missing`);
  const slash = docPath.lastIndexOf("/");
  const relsPath = `${docPath.slice(0, slash + 1)}_rels/${docPath.slice(slash + 1)}.rels`;
  return { files, docPath, relsPath };
}

/** XML part bytes as text, honouring a UTF-16 or UTF-8 byte order mark. */
export function decodePart(bytes: Uint8Array): string {
  const [a, b] = bytes;
  const encoding =
    a === 0xff && b === 0xfe ? "utf-16le" : a === 0xfe && b === 0xff ? "utf-16be" : "utf-8";
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

export const text = (pkg: Package, path: string) => {
  const bytes = pkg.files[path];
  return bytes ? decodePart(bytes) : undefined;
};

export interface DocParagraph {
  el: XmlElement;
  /** The field stack before this paragraph, so it can be analysed again on its own. */
  fieldsAtStart: Field[];
  model: ParagraphModel;
  info: BodyParagraph;
}

export interface DocModel {
  pkg: Package;
  src: string;
  root: XmlElement;
  paragraphs: DocParagraph[];
  existingEdits: ExistingEdit[];
  excludedRegions: Record<ExcludedKind, number>;
  /** Highest w:id in the parts that hold revisions, comments or bookmarks. */
  maxId: number;
}

const HEADING = /^heading\s*([1-9])$/i;

function headingLevel(pPr: XmlElement | undefined): number | null {
  if (!pPr) return null;
  const style = child(pPr, "w:pStyle")?.attrs["w:val"] ?? "";
  const match = HEADING.exec(style);
  if (match) return Number(match[1]);
  const outline = child(pPr, "w:outlineLvl")?.attrs["w:val"];
  return outline !== undefined && Number(outline) < 9 ? Number(outline) + 1 : null;
}

/** Counters per list, read as "3 > 3.2"; numbering.xml formats are not consulted. */
class SectionPath {
  private readonly lists = new Map<string, number[]>();
  private current: string | undefined;

  at(pPr: XmlElement | undefined): string | undefined {
    const heading = headingLevel(pPr);
    const numPr = pPr && child(pPr, "w:numPr");
    if (heading !== null) this.current = this.bump("heading", heading - 1);
    else if (numPr) {
      const numId = child(numPr, "w:numId")?.attrs["w:val"] ?? "0";
      const level = Number(child(numPr, "w:ilvl")?.attrs["w:val"] ?? "0");
      if (numId !== "0") this.current = this.bump(`num:${numId}`, level);
    }
    return this.current;
  }

  private bump(key: string, level: number): string {
    const counters = this.lists.get(key) ?? [];
    for (let i = 0; i < level; i++) counters[i] ??= 1;
    counters[level] = (counters[level] ?? 0) + 1;
    counters.length = level + 1;
    this.lists.set(key, counters);
    return counters.map((_, i) => counters.slice(0, i + 1).join(".")).join(" > ");
  }
}

const emptyRegions = (): Record<ExcludedKind, number> => ({
  header: 0,
  footer: 0,
  footnote: 0,
  endnote: 0,
  toc: 0,
  text_box: 0,
  shape: 0,
  content_control: 0,
  field: 0,
});

const notes = (xml: string | undefined, tag: string) =>
  xml
    ? elements(parseXml(xml), tag).filter((note) => {
        const type = note.attrs["w:type"];
        return type === undefined || type === "normal";
      }).length
    : 0;

const ID = /\bw:id\s*=\s*(["'])(-?\d+)\1/g;

/**
 * Paragraph indexing matches Office.js `body.paragraphs`, which the Word pane anchors by:
 * every w:p under w:body in document order, table-cell paragraphs included, nested
 * tables included. Paragraphs inside text boxes (w:txbxContent) are not indexed, and
 * headers, footers, footnotes, endnotes and comments are separate parts, never indexed.
 */
function loadUnchecked(bytes: Uint8Array): DocModel {
  const pkg = openPackage(bytes);
  const src = text(pkg, pkg.docPath) ?? "";
  const root = parseXml(src);
  if (root.attrs["xmlns:w"] !== W_NS)
    throw new DocxError("OOXML_INVALID", "document.xml must bind w: to WordprocessingML");
  const body = child(root, "w:body");
  if (!body) throw new DocxError("OOXML_INVALID", "document.xml has no w:body");

  const regions = emptyRegions();
  const paragraphs: DocParagraph[] = [];
  const existingEdits: ExistingEdit[] = [];
  const fields: Field[] = [];
  const sections = new SectionPath();

  const visitParagraph = (p: XmlElement, excluded: boolean, tocSdt: boolean) => {
    const fieldsAtStart = fields.map((field) => ({ ...field }));
    const model = analyseParagraph(p, src, fields, (kind) => {
      if (kind === "toc" && tocSdt) return;
      regions[kind]++;
    });
    const index = paragraphs.length;
    const isExcluded = excluded || model.inToc;
    const style = model.pPr && child(model.pPr, "w:pStyle")?.attrs["w:val"];
    const section = isExcluded ? undefined : sections.at(model.pPr);
    const info: BodyParagraph = {
      index,
      text: model.text,
      ...(section ? { section_path: section } : {}),
      ...(style ? { style } : {}),
      para_hash: paraHashSync(model.text),
      runs: model.runs.map((run, i) => ({
        run_index: i,
        char_from: run.from,
        char_to: run.to,
        rPr_hash: sha256(run.rPr ? sourceOf(run.rPr, src) : ""),
      })),
      excluded: isExcluded,
    };
    for (const edit of model.edits) existingEdits.push({ paragraph_index: index, ...edit });
    paragraphs.push({ el: p, fieldsAtStart, model, info });
  };

  const walkBlocks = (container: XmlElement, excluded: boolean, tocSdt: boolean) => {
    for (const node of elements(container)) {
      if (node.name === "w:p") visitParagraph(node, excluded, tocSdt);
      else if (node.name === "w:sdt") {
        const toc = isTocSdt(node);
        regions[toc ? "toc" : "content_control"]++;
        const content = child(node, "w:sdtContent");
        if (content) walkBlocks(content, true, tocSdt || toc);
      } else if (node.name !== "w:sectPr" && node.name !== "mc:Fallback") {
        // mc:Choice and mc:Fallback hold the same content twice; Word shows the choice.
        walkBlocks(node, excluded, tocSdt);
      }
    }
  };
  walkBlocks(body, false, false);

  // Drawings are written twice (DrawingML and a VML fallback); count the first only.
  // A shape is a drawn shape without a text box; pictures are not counted.
  const isShape = (el: XmlElement) => {
    if (el.name === "wps:wsp") return !child(el, "wps:txbx");
    if (el.name !== "w:pict") return false;
    return ![...descendants(el)].some(
      (inner) => inner.name === "v:textbox" || inner.name === "v:imagedata",
    );
  };
  for (const el of descendants(
    body,
    (el) => el.name === "mc:Fallback" || el.name === "w:txbxContent",
  )) {
    if (el.name === "w:txbxContent") regions.text_box++;
    else if (isShape(el)) regions.shape++;
  }

  const rels = relationships(text(pkg, pkg.relsPath));
  const partsOf = (name: string) =>
    new Set(
      rels.filter((rel) => relType(rel, name)).map((rel) => resolveTarget(pkg.docPath, rel.target)),
    );
  regions.header = partsOf("header").size;
  regions.footer = partsOf("footer").size;
  const partText = (name: string) => [...partsOf(name)].map((path) => text(pkg, path));
  regions.footnote = partText("footnotes").reduce((sum, xml) => sum + notes(xml, "w:footnote"), 0);
  regions.endnote = partText("endnotes").reduce((sum, xml) => sum + notes(xml, "w:endnote"), 0);

  let maxId = 0;
  for (const xml of [
    src,
    ...["comments", "footnotes", "endnotes", "header", "footer"].flatMap(partText),
  ]) {
    for (const match of xml?.matchAll(ID) ?? []) maxId = Math.max(maxId, Number(match[2]));
  }

  return { pkg, src, root, paragraphs, existingEdits, excludedRegions: regions, maxId };
}

/** Any failure to read the package (bad zip, bad XML, wrong namespace) is a DocxError. */
export function loadDocument(bytes: Uint8Array): DocModel {
  try {
    return loadUnchecked(bytes);
  } catch (error) {
    if (error instanceof DocxError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new DocxError("OOXML_INVALID", `not a readable .docx: ${message}`);
  }
}

/** The body of an existing .docx as the review and the Word pane see it. */
export function readDocx(bytes: Uint8Array): ReadResult {
  const doc = loadDocument(bytes);
  const paragraphs = doc.paragraphs.map((paragraph) => paragraph.info);
  return {
    paragraphs,
    existingEdits: doc.existingEdits,
    excludedRegions: doc.excludedRegions,
    charCount: paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length + 1, 0),
  };
}
