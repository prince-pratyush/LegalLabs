import { strFromU8, strToU8 } from "fflate";
import { DocxError, decodePart, relationships, resolveTarget } from "./read.js";
import { descendants, parseXml, textContent, type XmlElement } from "./tree.js";

// A translated copy is the sender's package with new words, so anything in it that runs, embeds
// another file or fetches from outside would reach whoever opens the copy. Such a file is refused.

// Internal relationships a document needs to be read; any other kind of part is refused.
const PARTS = new Set(
  [
    "officeDocument core-properties extended-properties custom-properties thumbnail styles",
    "stylesWithEffects numbering settings webSettings fontTable font theme header footer",
    "footnotes endnotes comments commentsExtended commentsExtensible commentsIds people image",
    "hyperlink customXml customXmlProps glossaryDocument printerSettings chart chartStyle",
    "chartColorStyle chartshapes themeOverride diagramData diagramLayout diagramQuickStyle",
    "diagramColors diagramDrawing hdphoto",
  ]
    .join(" ")
    .split(" "),
);
const NAMES = /vbaProject|vbaData|activeX|\/embeddings\/|^word\/embeddings|^customUI\//i;
const TYPES = /macroEnabled|vbaProject|vbaData|activeX|oleObject/i;
const ELEMENTS = new Set(["altChunk", "object", "OLEObject", "control", "subDoc"]);
// Fields that start a program or pull in something from elsewhere when updated.
const FIELDS = /^\s*(?:DDE|DDEAUTO|INCLUDETEXT|INCLUDEPICTURE|IMPORT|LINK|DATABASE|MACROBUTTON)\b/i;

const refuse = (what: string): never => {
  throw new DocxError("ACTIVE_CONTENT", what);
};

const local = (name: string) => name.slice(name.indexOf(":") + 1);

function checkElements(root: XmlElement, src: string) {
  // Instructions may be split over runs; they are read joined, from one field mark to the next.
  let instruction = "";
  const close = () => {
    if (FIELDS.test(instruction)) refuse("a field that fetches or runs");
    instruction = "";
  };
  for (const el of descendants(root)) {
    const name = local(el.name);
    if (ELEMENTS.has(name)) refuse(`${name} element`);
    if (name === "fldChar") close();
    else if (name === "instrText" || name === "delInstrText") instruction += textContent(el, src);
    else if (name === "fldSimple") {
      const instr = Object.entries(el.attrs).find(([key]) => local(key) === "instr")?.[1];
      if (instr && FIELDS.test(instr)) refuse("a field that fetches or runs");
    }
  }
  close();
}

// The one link removed rather than refused: firm documents often name the template they came from.
const TEMPLATE = /<w:attachedTemplate\b[^>]*\/>/g;

/** Refuses active content and returns the parts with any link to a template taken out. */
export function inertParts(files: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const out = { ...files };
  for (const [name, bytes] of Object.entries(files)) {
    if (NAMES.test(name)) refuse(name);
    if (name === "[Content_Types].xml") {
      if (TYPES.test(strFromU8(bytes))) refuse("an active content type");
    } else if (name.endsWith(".rels")) {
      const src = decodePart(bytes);
      const dropped = new Set<string>();
      for (const rel of relationships(src)) {
        const kind = rel.type.slice(rel.type.lastIndexOf("/") + 1);
        if (kind === "attachedTemplate") dropped.add(rel.id);
        else if (rel.external) {
          if (kind !== "hyperlink") refuse(`an outside ${kind}`);
        } else if (!PARTS.has(kind)) refuse(`a ${kind} part`);
        else if (NAMES.test(resolveTarget("", rel.target))) refuse(rel.target);
      }
      if (dropped.size > 0) {
        const kept = src.replace(/<Relationship\b[^>]*\/>/g, (el) =>
          /attachedTemplate"/.test(el) ? "" : el,
        );
        if (/attachedTemplate/.test(kept)) refuse("a template link that can't be removed");
        out[name] = strToU8(kept);
      }
    } else if (name.endsWith(".xml")) {
      let src = decodePart(bytes);
      if (name === "word/settings.xml" && TEMPLATE.test(src)) {
        src = src.replace(TEMPLATE, "");
        out[name] = strToU8(src);
      }
      checkElements(parseXml(src), src);
    }
  }
  return out;
}
