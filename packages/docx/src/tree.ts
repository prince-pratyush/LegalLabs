/**
 * A minimal XML tree that remembers where every node sits in the source text.
 * The patcher splices new XML into the original string, so everything it does
 * not rewrite (w:pPr, untouched runs, other paragraphs) survives byte for byte,
 * which a DOM round trip through a serializer does not promise.
 */

export interface XmlElement {
  type: "element";
  name: string;
  attrs: Record<string, string>;
  /** Offset of `<`. */
  start: number;
  /** Offset just past the start tag's `>`. */
  openEnd: number;
  /** Offset just past the end tag (or the start tag when self-closing). */
  end: number;
  children: XmlNode[];
  parent: XmlElement | null;
}

export interface XmlOther {
  type: "text" | "other";
  start: number;
  end: number;
  parent: XmlElement;
}

export type XmlNode = XmlElement | XmlOther;

export class XmlError extends Error {}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** A character reference must name an XML 1.0 character, or the document is not XML. */
function fromCharRef(code: number): string {
  const ok =
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff);
  if (!ok) throw new XmlError(`invalid character reference ${code}`);
  return String.fromCodePoint(code);
}

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith("#x")) return fromCharRef(Number.parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return fromCharRef(Number.parseInt(ref.slice(1), 10));
    return ENTITIES[ref] ?? whole;
  });
}

/** Deeper than any real document; the walks over the tree recurse once per level. */
export const MAX_DEPTH = 256;

const NAME_END = /[\s/>]/;

function indexOrThrow(src: string, needle: string, from: number): number {
  const at = src.indexOf(needle, from);
  if (at === -1) throw new XmlError(`unterminated markup at ${from}`);
  return at;
}

/** Parses well-formed XML; the result is the root element. */
export function parseXml(src: string): XmlElement {
  let root: XmlElement | null = null;
  let current: XmlElement | null = null;
  let depth = 0;
  let i = 0;
  const addLeaf = (type: XmlOther["type"], start: number, end: number) => {
    if (current) current.children.push({ type, start, end, parent: current });
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      addLeaf("text", i, src.length);
      break;
    }
    if (lt > i) addLeaf("text", i, lt);
    if (src.startsWith("<!--", lt)) {
      i = indexOrThrow(src, "-->", lt) + 3;
      addLeaf("other", lt, i);
    } else if (src.startsWith("<![CDATA[", lt)) {
      i = indexOrThrow(src, "]]>", lt) + 3;
      addLeaf("text", lt, i);
    } else if (src.startsWith("<?", lt)) {
      i = indexOrThrow(src, "?>", lt) + 2;
      addLeaf("other", lt, i);
    } else if (src.startsWith("<!", lt)) {
      // OOXML never has a DTD; refusing one rules out entity expansion tricks.
      throw new XmlError(`DOCTYPE or unknown declaration at ${lt}`);
    } else if (src[lt + 1] === "/") {
      const gt = indexOrThrow(src, ">", lt);
      const name = src.slice(lt + 2, gt).trim();
      if (!current || current.name !== name) throw new XmlError(`unexpected </${name}> at ${lt}`);
      current.end = gt + 1;
      current = current.parent;
      depth--;
      i = gt + 1;
    } else {
      let j = lt + 1;
      while (j < src.length && !NAME_END.test(src[j] ?? "")) j++;
      const name = src.slice(lt + 1, j);
      const attrs: Record<string, string> = {};
      for (;;) {
        while (/\s/.test(src[j] ?? "")) j++;
        const c = src[j];
        if (c === undefined) throw new XmlError(`unterminated tag at ${lt}`);
        if (c === ">" || c === "/") break;
        const eq = indexOrThrow(src, "=", j);
        const key = src.slice(j, eq).trim();
        let q = eq + 1;
        while (/\s/.test(src[q] ?? "")) q++;
        const quote = src[q];
        if (quote !== '"' && quote !== "'") throw new XmlError(`unquoted attribute at ${q}`);
        const close = indexOrThrow(src, quote, q + 1);
        attrs[key] = decodeXml(src.slice(q + 1, close));
        j = close + 1;
      }
      const selfClosing = src[j] === "/";
      const gt = indexOrThrow(src, ">", j);
      const el: XmlElement = {
        type: "element",
        name,
        attrs,
        start: lt,
        openEnd: gt + 1,
        end: gt + 1,
        children: [],
        parent: current,
      };
      if (current) current.children.push(el);
      else if (root) throw new XmlError("more than one root element");
      else root = el;
      if (!selfClosing) {
        current = el;
        if (++depth > MAX_DEPTH) throw new XmlError(`nesting deeper than ${MAX_DEPTH}`);
      }
      i = gt + 1;
    }
  }
  if (!root || current) throw new XmlError("unbalanced document");
  return root;
}

export const elements = (el: XmlElement, name?: string): XmlElement[] =>
  el.children.filter(
    (child): child is XmlElement =>
      child.type === "element" && (name === undefined || child.name === name),
  );

export const child = (el: XmlElement, name: string): XmlElement | undefined =>
  elements(el, name)[0];

/** Every descendant element in document order, not entering `skip` elements. */
export function* descendants(el: XmlElement, skip?: (el: XmlElement) => boolean) {
  const stack = [...elements(el)].reverse();
  for (;;) {
    const next = stack.pop();
    if (!next) return;
    yield next;
    if (!skip?.(next)) stack.push(...[...elements(next)].reverse());
  }
}

/** Decoded character data directly inside an element, as in `w:t`. */
export function textContent(el: XmlElement, src: string): string {
  return el.children
    .filter((node) => node.type === "text")
    .map((node) => {
      const raw = src.slice(node.start, node.end);
      return raw.startsWith("<![CDATA[") ? raw.slice(9, -3) : decodeXml(raw);
    })
    .join("");
}

export const sourceOf = (node: XmlNode, src: string) => src.slice(node.start, node.end);

export function ancestor(el: XmlElement, name: string): XmlElement | undefined {
  for (let at = el.parent; at; at = at.parent) if (at.name === name) return at;
  return undefined;
}
