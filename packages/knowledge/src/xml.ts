import { DOMParser, type Element, type Node } from "@xmldom/xmldom";
import { clean } from "./text.js";

/**
 * The root element of a well-formed document. These sources never send a document
 * type, and entity declarations are how XML attacks start, so either is refused.
 */
export function parseXml(xml: string): Element {
  if (/<!(?:DOCTYPE|ENTITY)/i.test(xml)) throw new Error("XML with a document type is refused");
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level !== "warning") throw new Error(`invalid XML: ${message.slice(0, 200)}`);
    },
  });
  const root = parser.parseFromString(xml, "text/xml").documentElement;
  if (!root) throw new Error("invalid XML: no root element");
  return root;
}

const isElement = (node: Node): node is Element => node.nodeType === 1;

export const childElements = (element: Element): Element[] =>
  Array.from(element.childNodes).filter(isElement);

/**
 * An element's text as lines: inline elements join their neighbours, others break the line.
 * `override` writes an element itself, for the ones a source needs set out differently.
 */
export function readableText(
  element: Element,
  inline: ReadonlySet<string>,
  override: (element: Element) => string | null = () => null,
): string {
  const walk = (node: Node): string => {
    // Line breaks in the source are only layout; text and CDATA are the other node kinds kept.
    if (node.nodeType === 3 || node.nodeType === 4)
      return (node.nodeValue ?? "").replace(/\s+/g, " ");
    if (!isElement(node)) return "";
    const own = override(node);
    if (own !== null) return own;
    const body = Array.from(node.childNodes).map(walk).join("");
    return inline.has(node.localName ?? "") ? body : `\n${body}\n`;
  };
  return clean(walk(element))
    .split("\n")
    .map((line) => line.replace(/ +/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
