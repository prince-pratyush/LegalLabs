import { DOMParser } from "@xmldom/xmldom";
import { strToU8, type ZipOptions, zipSync } from "fflate";
import { diffWords } from "./diff.js";
import { delXml, insXml, markXml, type RawRun, type Revision, runXml, textXml } from "./docx.js";
import {
  analyseParagraph,
  type DocModel,
  type Field,
  type Item,
  loadDocument,
  type Package,
  REL_NS,
  relationships,
  relType,
  resolveTarget,
  text,
  W_NS,
} from "./read.js";
import { child, elements, parseXml, sourceOf, type XmlElement } from "./tree.js";
import { isoSeconds, XML_HEAD, xmlText } from "./xml.js";

export interface PatchEdit {
  id: string;
  /** "replace" swaps `before` for `after` inside the paragraph; "insert_after" adds a paragraph. */
  kind: "replace" | "insert_after";
  paragraph_index: number;
  before: string;
  after: string;
  comment?: string;
}

export interface PatchOptions {
  author: string;
  date: Date | string;
  /** Open the patched file in track-changes mode; on by default. */
  trackRevisions?: boolean;
}

export type PatchFailureCode =
  | "ANCHOR_FAILED"
  | "EXCLUDED_REGION"
  | "UNSUPPORTED_CONTENT"
  | "NO_CHANGE"
  | "OOXML_INVALID";

export class PatchError extends Error {
  constructor(
    readonly code: PatchFailureCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PatchResult {
  bytes: Uint8Array;
  applied: string[];
  failed: { id: string; code: PatchFailureCode }[];
}

const SPACE = /\s+/u;
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The one place `before` occurs, whitespace runs compared loosely; null if absent or repeated. */
function locate(text: string, before: string): [number, number] | null {
  const words = before.split(SPACE).filter(Boolean);
  if (!words.length) return null;
  const matches = [...text.matchAll(new RegExp(words.map(escapeRegex).join("\\s+"), "gu"))];
  const only = matches.length === 1 ? matches[0] : undefined;
  return only ? [only.index, only.index + only[0].length] : null;
}

/** Run formatting for new text, minus any record of an earlier formatting change. */
function insertedRPr(rPr: XmlElement | undefined, src: string): string {
  if (!rPr) return "";
  const change = child(rPr, "w:rPrChange");
  const xml = sourceOf(rPr, src);
  if (!change) return xml;
  return xml.slice(0, change.start - rPr.start) + xml.slice(change.end - rPr.start);
}

interface Op {
  op: "equal" | "insert" | "delete";
  a: number;
  b: number;
  text: string;
}

/** The diff in paragraph coordinates, with the text outside `before` as equal. */
function paragraphOps(text: string, from: number, to: number, after: string): Op[] {
  const ops: Op[] = [];
  const push = (op: Op["op"], length: number, piece: string) => {
    const a = ops.length ? (ops[ops.length - 1] as Op).b : 0;
    const b = op === "insert" ? a : a + length;
    const last = ops[ops.length - 1];
    if (last && last.op === op && op === "equal") {
      last.b = b;
      last.text += piece;
    } else if (piece) ops.push({ op, a, b, text: piece });
  };
  push("equal", from, text.slice(0, from));
  for (const op of diffWords(text.slice(from, to), after)) push(op.op, op.text.length, op.text);
  push("equal", text.length - to, text.slice(to));
  return ops;
}

function conflict(ops: readonly Op[], items: readonly Item[]): Item["lock"] {
  for (const op of ops) {
    if (op.op === "equal") continue;
    for (const item of items) {
      if (!item.lock) continue;
      const hit =
        item.to > item.from
          ? op.op === "delete"
            ? item.from < op.b && item.to > op.a
            : item.from < op.a && op.a < item.to
          : op.op === "delete" && op.a < item.from && item.from < op.b;
      if (hit) return item.lock;
    }
  }
  return undefined;
}

interface Piece {
  item: Item;
  from: number;
  to: number;
  whole: boolean;
}

/** Items in order, plain runs cut wherever the diff changes from one op to another. */
function pieces(items: readonly Item[], ops: readonly Op[]): Piece[] {
  const cuts = new Set<number>();
  for (const op of ops) {
    if (op.op !== "equal") cuts.add(op.a).add(op.b);
  }
  const out: Piece[] = [];
  for (const item of items) {
    if (!item.run || item.to === item.from) {
      out.push({ item, from: item.from, to: item.to, whole: true });
      continue;
    }
    const bounds = [
      item.from,
      ...[...cuts].filter((at) => at > item.from && at < item.to).sort((x, y) => x - y),
      item.to,
    ];
    for (let i = 0; i + 1 < bounds.length; i++) {
      out.push({
        item,
        from: bounds[i] as number,
        to: bounds[i + 1] as number,
        whole: bounds.length === 2,
      });
    }
  }
  return out;
}

interface CommentMarks {
  id: number;
}

const commentStart = (c: CommentMarks | undefined) =>
  c ? `<w:commentRangeStart w:id="${c.id}"/>` : "";
const commentEnd = (c: CommentMarks | undefined) =>
  c ? `<w:commentRangeEnd w:id="${c.id}"/><w:r><w:commentReference w:id="${c.id}"/></w:r>` : "";

/**
 * Applies one edit to one paragraph's XML. Returns the paragraph to put in its place
 * (replace) or the new paragraph to add after it (insert_after). Throws PatchError.
 */
export function patchParagraph(
  pxml: string,
  fieldsAtStart: readonly Field[],
  edit: PatchEdit,
  rev: Revision,
  comment?: () => number,
): string {
  const p = parseXml(pxml);
  const model = analyseParagraph(
    p,
    pxml,
    fieldsAtStart.map((field) => ({ ...field })),
  );
  const firstRun = model.items.find((item) => item.run)?.run;
  if (edit.kind === "insert_after") {
    if (edit.before.trim() && !locate(model.text, edit.before)) {
      throw new PatchError("ANCHOR_FAILED", "before text not found in the anchor paragraph");
    }
    if (!edit.after.trim()) throw new PatchError("NO_CHANGE", "nothing to insert");
    const marks = comment ? { id: comment() } : undefined;
    // Like pressing Enter at the end of the anchor: same style and numbering, but no
    // section break or recorded property change of its own.
    const kept = model.pPr
      ? model.pPr.children
          .filter(
            (node) =>
              node.type !== "element" || !["w:rPr", "w:sectPr", "w:pPrChange"].includes(node.name),
          )
          .map((node) => sourceOf(node, pxml))
          .join("")
      : "";
    const pPr = `<w:pPr>${kept}<w:rPr>${markXml("ins", rev)}</w:rPr></w:pPr>`;
    const rPr = insertedRPr(firstRun?.rPr, pxml);
    return `<w:p>${pPr}${commentStart(marks)}${insXml([{ text: edit.after, rPr }], rev)}${commentEnd(marks)}</w:p>`;
  }

  const span = locate(model.text, edit.before);
  if (!span) throw new PatchError("ANCHOR_FAILED", "before text not found exactly once");
  const ops = paragraphOps(model.text, span[0], span[1], edit.after);
  const changed = ops.filter((op) => op.op !== "equal");
  const first = changed[0];
  const last = changed[changed.length - 1];
  if (!first || !last) throw new PatchError("NO_CHANGE", "after equals before");
  const lock = conflict(ops, model.items);
  if (lock) throw new PatchError(lock, "the change touches text that cannot be edited");

  const cut = pieces(model.items, ops);
  const at = first.a;
  const host =
    cut.find((piece) => piece.item.run && piece.from <= at && at < piece.to) ??
    cut.findLast((piece) => piece.item.run && piece.to === at);
  const insRPr = insertedRPr((host?.item.run ?? firstRun)?.rPr, pxml);
  const marks = comment ? { id: comment() } : undefined;

  const plain = (piece: Piece) => {
    const run = piece.item.run;
    if (piece.whole || !run) return sourceOf(piece.item.node, pxml);
    const open = pxml.slice(run.el.start, run.el.openEnd);
    const rPr = run.rPr ? sourceOf(run.rPr, pxml) : "";
    return `${open}${rPr}${textXml(model.text.slice(piece.from, piece.to), "w:t")}</w:r>`;
  };

  let out = "";
  let k = 0;
  for (const op of ops) {
    if (op === first) out += commentStart(marks);
    if (op.op === "insert") out += insXml([{ text: op.text, rPr: insRPr }], rev);
    else {
      let gone: RawRun[] = [];
      const flush = () => {
        out += delXml(gone, rev);
        gone = [];
      };
      for (; k < cut.length && (cut[k] as Piece).from < op.b; k++) {
        const piece = cut[k] as Piece;
        const run = piece.item.run;
        if (op.op === "delete" && run && piece.to > piece.from) {
          gone.push({
            text: model.text.slice(piece.from, piece.to),
            rPr: run.rPr ? sourceOf(run.rPr, pxml) : "",
          });
        } else {
          flush();
          out += plain(piece);
        }
      }
      flush();
    }
    if (op === last) out += commentEnd(marks);
  }
  for (; k < cut.length; k++) out += plain(cut[k] as Piece);

  const head = pxml.slice(0, model.pPr ? model.pPr.end : p.openEnd);
  if (p.openEnd === p.end) return `${head.slice(0, -2)}>${out}</w:p>`;
  return `${head}${out}</w:p>`;
}

function assertWellFormed(name: string, xml: string) {
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level !== "warning") throw new PatchError("OOXML_INVALID", `${name}: ${message}`);
    },
  });
  parser.parseFromString(xml, "text/xml");
}

function targetParagraph(doc: DocModel, edit: PatchEdit) {
  const paragraph = doc.paragraphs[edit.paragraph_index];
  if (!paragraph) throw new PatchError("ANCHOR_FAILED", "no paragraph at that index");
  if (paragraph.info.excluded) {
    throw new PatchError("EXCLUDED_REGION", "the paragraph is in an excluded region");
  }
  return paragraph;
}

const CT = "application/vnd.openxmlformats-officedocument.wordprocessingml";

/** Adds a part's relationship and content type when the package lacks them. */
class Registry {
  rels: string | undefined;
  types: string | undefined;

  constructor(private readonly pkg: Package) {
    this.rels = text(pkg, pkg.relsPath);
    this.types = text(pkg, "[Content_Types].xml");
  }

  /** The part's path, registering `fallback` if the document has no such part. */
  part(type: string, fallback: string, contentType: string): string {
    const found = relationships(this.rels).find((rel) => relType(rel, type));
    if (found) return resolveTarget(this.pkg.docPath, found.target);
    const used = new Set(relationships(this.rels).map((rel) => rel.id));
    let n = used.size + 1;
    while (used.has(`rId${n}`)) n++;
    const rel = `<Relationship Id="rId${n}" Type="${REL_NS}/${type}" Target="${fallback}"/>`;
    this.rels = this.rels
      ? appendChild(this.rels, rel)
      : `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel}</Relationships>`;
    const path = resolveTarget(this.pkg.docPath, fallback);
    const types = this.types ?? "";
    const declared = elements(parseXml(types), "Override").some(
      (el) => el.attrs.PartName === `/${path}`,
    );
    if (!declared) {
      this.types = appendChild(
        types,
        `<Override PartName="/${path}" ContentType="${contentType}"/>`,
      );
    }
    return path;
  }
}

/** Inserts XML as the last child of the root element. */
function appendChild(xml: string, inner: string): string {
  const root = parseXml(xml);
  if (root.openEnd === root.end) {
    const open = xml.slice(root.start, root.openEnd).replace(/\s*\/>$/, ">");
    return `${xml.slice(0, root.start)}${open}${inner}</${root.name}>${xml.slice(root.end)}`;
  }
  const close = xml.lastIndexOf("</", root.end);
  return xml.slice(0, close) + inner + xml.slice(close);
}

// CT_Settings is a sequence: trackRevisions must follow exactly these, if present.
const BEFORE_TRACK = new Set(
  "writeProtection view zoom removePersonalInformation removeDateAndTime doNotDisplayPageBoundaries displayBackgroundShape printPostScriptOverText printFractionalCharacterWidth printFormsData embedTrueTypeFonts embedSystemFonts saveSubsetFonts saveFormsData mirrorMargins alignBordersAndEdges bordersDoNotSurroundHeader bordersDoNotSurroundFooter gutterAtTop hideSpellingErrors hideGrammaticalErrors activeWritingStyle proofState formsDesign attachedTemplate linkStyles stylePaneFormatFilter stylePaneSortMethod documentType mailMerge revisionView"
    .split(" ")
    .map((name) => `w:${name}`),
);

function withTrackRevisions(xml: string | undefined): string {
  if (!xml) return `${XML_HEAD}<w:settings xmlns:w="${W_NS}"><w:trackRevisions/></w:settings>`;
  const root = parseXml(xml);
  const existing = child(root, "w:trackRevisions");
  if (existing) {
    const value = existing.attrs["w:val"];
    if (value === undefined || ["true", "1", "on"].includes(value)) return xml;
    return `${xml.slice(0, existing.start)}<w:trackRevisions/>${xml.slice(existing.end)}`;
  }
  const next = elements(root).find((el) => !BEFORE_TRACK.has(el.name));
  if (!next) return appendChild(xml, "<w:trackRevisions/>");
  return `${xml.slice(0, next.start)}<w:trackRevisions/>${xml.slice(next.start)}`;
}

function commentXml(id: number, body: string, author: string, date: string): string {
  const paragraphs = body
    .split(/\r?\n/)
    .map(
      (line, i) =>
        `<w:p>${i === 0 ? "<w:r><w:annotationRef/></w:r>" : ""}${runXml({ text: line })}</w:p>`,
    )
    .join("");
  return `<w:comment w:id="${id}" w:author="${xmlText(author)}" w:date="${date}">${paragraphs}</w:comment>`;
}

/**
 * Applies edits to an existing .docx as tracked changes. Only document.xml,
 * comments.xml, settings.xml, [Content_Types].xml and the document's relationships
 * are rewritten; every other part is copied unchanged. Same input, same bytes.
 */
export function patchDocx(
  bytes: Uint8Array,
  edits: readonly PatchEdit[],
  opts: PatchOptions,
): PatchResult {
  const date = isoSeconds(opts.date);
  const doc = loadDocument(bytes);
  let next = doc.maxId + 1;
  const rev: Revision = { id: () => next++, author: opts.author, date };
  const patched = new Map<number, { xml: string; after: string[] }>();
  const comments: string[] = [];
  const applied: string[] = [];
  const failed: PatchResult["failed"] = [];

  for (const edit of edits) {
    try {
      const paragraph = targetParagraph(doc, edit);
      const state = patched.get(edit.paragraph_index) ?? {
        xml: sourceOf(paragraph.el, doc.src),
        after: [],
      };
      const body = edit.comment;
      const allocate = body
        ? () => {
            const id = next++;
            comments.push(commentXml(id, body, opts.author, date));
            return id;
          }
        : undefined;
      const xml = patchParagraph(state.xml, paragraph.fieldsAtStart, edit, rev, allocate);
      if (edit.kind === "replace") state.xml = xml;
      else state.after.push(xml);
      patched.set(edit.paragraph_index, state);
      applied.push(edit.id);
    } catch (error) {
      if (!(error instanceof PatchError)) throw error;
      failed.push({ id: edit.id, code: error.code });
    }
  }

  let document = doc.src;
  const order = [...patched.entries()].sort(
    ([a], [b]) => (doc.paragraphs[b]?.el.start ?? 0) - (doc.paragraphs[a]?.el.start ?? 0),
  );
  for (const [index, state] of order) {
    const el = (doc.paragraphs[index] as { el: XmlElement }).el;
    document =
      document.slice(0, el.start) + state.xml + state.after.join("") + document.slice(el.end);
  }

  const out: Record<string, string> = { [doc.pkg.docPath]: document };
  const registry = new Registry(doc.pkg);
  if (comments.length) {
    const path = registry.part("comments", "comments.xml", `${CT}.comments+xml`);
    const existing = text(doc.pkg, path);
    out[path] = existing
      ? appendChild(existing, comments.join(""))
      : `${XML_HEAD}<w:comments xmlns:w="${W_NS}">${comments.join("")}</w:comments>`;
  }
  if (opts.trackRevisions ?? true) {
    const path = registry.part("settings", "settings.xml", `${CT}.settings+xml`);
    out[path] = withTrackRevisions(text(doc.pkg, path));
  }
  if (registry.rels !== text(doc.pkg, doc.pkg.relsPath) && registry.rels) {
    out[doc.pkg.relsPath] = registry.rels;
  }
  if (registry.types !== text(doc.pkg, "[Content_Types].xml") && registry.types) {
    out["[Content_Types].xml"] = registry.types;
  }
  for (const [name, xml] of Object.entries(out)) assertWellFormed(name, xml);

  const mtime = new Date(date);
  const files: Record<string, [Uint8Array, ZipOptions]> = {};
  for (const [name, data] of Object.entries(doc.pkg.files)) {
    const replaced = out[name];
    files[name] = [replaced === undefined ? data : strToU8(replaced), { mtime }];
  }
  for (const [name, xml] of Object.entries(out)) files[name] ??= [strToU8(xml), { mtime }];
  return { bytes: zipSync(files, { level: 6 }), applied, failed };
}

const PKG_NS = "http://schemas.microsoft.com/office/2006/xmlPackage";

/**
 * One patched paragraph as the Flat OPC package Office.js `insertOoxml` takes: a
 * relationships part and a document part, the paragraph alone in w:body. The document
 * keeps the original root's namespace declarations so any w14/mc/r markup in the
 * paragraph still resolves. A replace yields the whole patched paragraph, for
 * `paragraph.insertOoxml(ooxml, "Replace")`; insert_after yields only the new
 * paragraph, for `paragraph.insertOoxml(ooxml, "After")`. The comment is left out:
 * the pane adds it with `range.insertComment` so it attaches to the live range.
 */
export function paragraphFragment(bytes: Uint8Array, edit: PatchEdit, opts: PatchOptions): string {
  const doc = loadDocument(bytes);
  const paragraph = targetParagraph(doc, edit);
  let next = doc.maxId + 1;
  const rev: Revision = { id: () => next++, author: opts.author, date: isoSeconds(opts.date) };
  const xml = patchParagraph(sourceOf(paragraph.el, doc.src), paragraph.fieldsAtStart, edit, rev);
  const namespaces = Object.entries(doc.root.attrs)
    .filter(([name]) => name.startsWith("xmlns") || name === "mc:Ignorable")
    .map(([name, value]) => ` ${name}="${xmlText(value)}"`)
    .join("");
  const fragment = `<?xml version="1.0" standalone="yes"?><?mso-application progid="Word.Document"?><pkg:package xmlns:pkg="${PKG_NS}"><pkg:part pkg:name="/_rels/.rels" pkg:contentType="application/vnd.openxmlformats-package.relationships+xml" pkg:padding="512"><pkg:xmlData><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="word/document.xml"/></Relationships></pkg:xmlData></pkg:part><pkg:part pkg:name="/word/document.xml" pkg:contentType="${CT}.document.main+xml"><pkg:xmlData><w:document${namespaces}><w:body>${xml}</w:body></w:document></pkg:xmlData></pkg:part></pkg:package>`;
  assertWellFormed("fragment", fragment);
  return fragment;
}
