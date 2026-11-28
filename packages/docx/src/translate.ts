import { strToU8, zipSync } from "fflate";
import { DocxError, decodePart, openPackage } from "./read.js";
import { elements, parseXml, sourceOf, textContent, type XmlElement } from "./tree.js";
import { xmlText } from "./xml.js";

// Translation rewrites the words of w:t elements and nothing else, so every style, list, table,
// field and tracked change stays byte for byte as it was.

/** The parts of a package that hold words a reader sees. */
const WORDS = /^word\/(?:document\d*|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
// Neither is text in place: a deleted run is history, and the fallback repeats the choice.
const SKIPPED = new Set(["w:del", "w:moveFrom", "mc:Fallback"]);

interface Segment {
  text: string;
  /** The w:t elements holding it, in order. */
  holders: XmlElement[];
}

/** Stretches of text in one paragraph that share a look, broken at tabs and line breaks. */
function segmentsOf(root: XmlElement, src: string): Segment[] {
  const found: Segment[] = [];
  let open: { segment: Segment; look: string } | null = null;
  const visit = (el: XmlElement) => {
    if (SKIPPED.has(el.name)) return;
    if (el.name === "w:r") {
      const rPr = elements(el, "w:rPr")[0];
      const look = rPr ? sourceOf(rPr, src) : "";
      for (const inner of elements(el)) {
        if (inner.name === "w:t") {
          const text = textContent(inner, src);
          if (open?.look !== look) {
            open = { segment: { text: "", holders: [] }, look };
            found.push(open.segment);
          }
          open.segment.text += text;
          open.segment.holders.push(inner);
        } else if (inner.name !== "w:rPr" && inner.name !== "w:lastRenderedPageBreak") {
          // A tab, break, picture or field mark: words don't move across it.
          open = null;
          visit(inner);
        }
      }
      return;
    }
    // A paragraph inside a text box is its own paragraph, and the outer one resumes after it.
    const boundary = el.name === "w:p" || el.name === "w:hyperlink";
    if (boundary) open = null;
    for (const child of elements(el)) visit(child);
    if (boundary) open = null;
  };
  visit(root);
  return found;
}

export interface OpenText {
  /** Every stretch of words, to be translated one for one. */
  segments: string[];
  /** The same file with each segment replaced; null keeps the original words. */
  apply(translated: readonly (string | null)[]): Uint8Array;
}

export function openText(bytes: Uint8Array): OpenText {
  try {
    const pkg = openPackage(bytes);
    const names = Object.keys(pkg.files)
      .filter((name) => name === pkg.docPath || WORDS.test(name))
      // The body first, so its words lead the batches.
      .sort((a, b) => Number(b === pkg.docPath) - Number(a === pkg.docPath) || a.localeCompare(b));
    const parts = names.map((name) => {
      const raw = pkg.files[name] as Uint8Array;
      // Written back as UTF-8, which a part declaring UTF-16 would then misstate.
      if (raw[0] === 0xff || raw[0] === 0xfe) {
        throw new DocxError("OOXML_INVALID", `${name} is not UTF-8`);
      }
      const src = decodePart(raw);
      return { name, src, segments: segmentsOf(parseXml(src), src) };
    });
    const all = parts.flatMap((part) => part.segments);
    return {
      segments: all.map((segment) => segment.text),
      apply(translated) {
        const files = { ...pkg.files };
        let n = 0;
        for (const part of parts) {
          const edits: { start: number; end: number; xml: string }[] = [];
          for (const segment of part.segments) {
            const words = translated[n++];
            if (words === null || words === undefined || words === segment.text) continue;
            segment.holders.forEach((el, i) => {
              edits.push({
                start: el.start,
                end: el.end,
                xml: i === 0 ? `<w:t xml:space="preserve">${xmlText(words)}</w:t>` : "<w:t></w:t>",
              });
            });
          }
          if (edits.length === 0) continue;
          edits.sort((a, b) => a.start - b.start);
          let out = "";
          let at = 0;
          for (const edit of edits) {
            out += part.src.slice(at, edit.start) + edit.xml;
            at = edit.end;
          }
          files[part.name] = strToU8(out + part.src.slice(at));
        }
        return zipSync(files, { level: 6 });
      },
    };
  } catch (error) {
    if (error instanceof DocxError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new DocxError("OOXML_INVALID", `not a readable .docx: ${message}`);
  }
}
