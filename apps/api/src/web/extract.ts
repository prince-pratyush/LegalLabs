import { decodeEntities } from "@legallabs/knowledge";
import { storable, stripInvisible } from "../connectors/sanitise.js";

/*
 * Readable text from a page nobody here wrote. One pass over the markup, so hostile input
 * costs no more than its length. Scripts, frames and what a reader would not see are dropped;
 * text hidden by a stylesheet cannot be told apart, so the result is still untrusted.
 */

export const MAX_TEXT = 200_000;
const MAX_HTML = 2_000_000;
const MAX_TITLE = 300;
const MAX_STYLE = 2000;

// Their contents are not markup: everything up to the matching end tag is one lump.
const RAW = new Set(["script", "style", "noscript", "iframe", "noembed", "noframes", "textarea"]);
// Parsed as usual, but nothing inside them is prose.
const SILENT = new Set(["template", "svg", "math", "select", "object", "canvas", "video", "audio"]);
const VOID = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" "),
);
const BLOCK = new Set(
  (
    "address article aside blockquote br caption dd div dl dt fieldset figcaption figure footer " +
    "h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table td th tr ul"
  ).split(" "),
);

const TAG = /<(\/?)([a-zA-Z][^\s/>]*)/y;
const ATTRIBUTE = /[^\s/>"'=]+/y;
const SPACE = /\s*/y;
const UNQUOTED = /[^\s>]*/y;

const matchAt = (pattern: RegExp, text: string, at: number) => {
  pattern.lastIndex = at;
  return pattern.exec(text);
};
const after = (pattern: RegExp, text: string, at: number) =>
  at + (matchAt(pattern, text, at)?.[0].length ?? 0);

/** The attributes that can hide an element, and where the tag ends; null when it never does. */
function readTag(html: string, from: number) {
  const attributes = new Map<string, string>();
  let at = from;
  let selfClosing = false;
  while (at < html.length) {
    at = after(SPACE, html, at);
    const char = html[at];
    if (char === ">") return { attributes, selfClosing, end: at + 1 };
    const name = matchAt(ATTRIBUTE, html, at)?.[0];
    if (!name) {
      selfClosing = char === "/";
      at += 1;
      continue;
    }
    selfClosing = false;
    at = after(SPACE, html, at + name.length);
    let value = "";
    if (html[at] === "=") {
      at = after(SPACE, html, at + 1);
      const quote = html[at];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, at + 1);
        if (close === -1) return null;
        value = html.slice(at + 1, close);
        at = close + 1;
      } else {
        value = matchAt(UNQUOTED, html, at)?.[0] ?? "";
        at += value.length;
      }
    }
    const key = name.toLowerCase();
    if ((key === "hidden" || key === "aria-hidden" || key === "style") && !attributes.has(key)) {
      attributes.set(key, value.slice(0, MAX_STYLE));
    }
  }
  return null;
}

function isHidden(attributes: ReadonlyMap<string, string>): boolean {
  if (attributes.has("hidden")) return true;
  if (attributes.get("aria-hidden")?.toLowerCase() === "true") return true;
  const style = decodeEntities(attributes.get("style") ?? "")
    .toLowerCase()
    .replace(/\s+/g, "");
  return /display:none|visibility:hidden|(?:font-size|opacity):0(?![.\d])/.test(style);
}

const tidy = (text: string) => stripInvisible(storable(decodeEntities(text)));

export function readPage(source: string): { title: string; text: string } {
  const html = source.slice(0, MAX_HTML);
  const parts: string[] = [];
  let title = "";
  // Open elements, and how many of them (or of one name) there are, so closing stays linear.
  const open: { name: string; hides: boolean }[] = [];
  const named = new Map<string, number>();
  let hidden = 0;
  const say = (text: string) => {
    if (hidden === 0) parts.push(text);
  };

  let at = 0;
  while (at < html.length) {
    const next = html.indexOf("<", at);
    const stop = next === -1 ? html.length : next;
    if (stop > at) say(html.slice(at, stop).replace(/\s+/g, " "));
    if (next === -1) break;
    if (html.startsWith("<!--", next)) {
      const close = html.indexOf("-->", next + 4);
      at = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html[next + 1] === "!" || html[next + 1] === "?") {
      const close = html.indexOf(">", next + 1);
      at = close === -1 ? html.length : close + 1;
      continue;
    }
    const found = matchAt(TAG, html, next);
    if (!found) {
      say("<");
      at = next + 1;
      continue;
    }
    const closing = found[1] === "/";
    const name = (found[2] ?? "").toLowerCase();
    const tag = readTag(html, next + found[0].length);
    if (!tag) break;
    at = tag.end;
    if (BLOCK.has(name)) say("\n");

    if (closing) {
      if (!named.get(name)) continue;
      for (let element = open.pop(); element; element = open.pop()) {
        named.set(element.name, (named.get(element.name) ?? 1) - 1);
        if (element.hides) hidden -= 1;
        if (element.name === name) break;
      }
      continue;
    }
    if (RAW.has(name) || name === "title") {
      const end = new RegExp(`</${name}(?=[\\s/>])`, "gi");
      end.lastIndex = at;
      const close = end.exec(html);
      if (name === "title" && !title) title = html.slice(at, close?.index ?? at);
      at = close ? close.index : html.length;
      continue;
    }
    if (VOID.has(name) || (tag.selfClosing && SILENT.has(name))) continue;
    const hides = SILENT.has(name) || isHidden(tag.attributes);
    open.push({ name, hides });
    named.set(name, (named.get(name) ?? 0) + 1);
    if (hides) hidden += 1;
  }

  const text = tidy(parts.join(""))
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return {
    title: tidy(title).replace(/\s+/g, " ").trim().slice(0, MAX_TITLE),
    text: storable(text.slice(0, MAX_TEXT)),
  };
}
