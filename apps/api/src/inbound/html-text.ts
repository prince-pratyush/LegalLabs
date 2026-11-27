// HTML to text for a message that has no plain part. One pass over the input, no expression
// that can backtrack across it, and no address in it is ever followed.

const MAX_HTML = 2 * 1024 * 1024;
const SKIPPED = new Set(["script", "style", "head", "title"]);
const BLOCKS = new Set("p div br tr li ul ol table blockquote pre h1 h2 h3 h4 h5 h6 hr".split(" "));
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, name: string) => {
    if (name[0] !== "#") return NAMED[name.toLowerCase()] ?? whole;
    const code = Number(name[1]?.toLowerCase() === "x" ? `0x${name.slice(2)}` : name.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

export function htmlToText(input: string): string {
  const html = input.slice(0, MAX_HTML);
  // ASCII only, so that positions in the two strings stay the same.
  const lower = html.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  let out = "";
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open < 0) {
      out += html.slice(at);
      break;
    }
    out += html.slice(at, open);
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      if (end < 0) break;
      at = end + 3;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    if (close < 0) break;
    const [, slash, name = ""] = /^<(\/?)([a-z0-9]*)/.exec(lower.slice(open, open + 16)) ?? [];
    at = close + 1;
    if (!slash && SKIPPED.has(name)) {
      const end = lower.indexOf(`</${name}`, at);
      if (end < 0) break;
      at = end;
    } else if (BLOCKS.has(name)) {
      out += "\n";
    }
  }
  return decode(out)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
