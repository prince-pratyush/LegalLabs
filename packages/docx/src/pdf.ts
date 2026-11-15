import { PDFDocument, type PDFFont, type PDFPage, StandardFonts } from "pdf-lib";
import type { Block, BlockKind } from "./markdown.js";
import {
  elements,
  openTemplate,
  paragraphText,
  partText,
  relatedPart,
  relsOf,
  type StyleInfo,
  stylesOf,
  type TemplateParts,
} from "./template.js";
import { isoSeconds } from "./xml.js";

/** What a PDF borrows from a firm template; sizes are in points. */
export interface PageLook {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  /** The PDF's built-in fonts only, so it needs no font files: Times, Helvetica or Courier. */
  family: "serif" | "sans" | "mono";
  styles: Record<"normal" | "title" | "heading1" | "heading2" | "heading3", TextLook>;
  /** e.g. `(%1)` with `lowerLetter`, from the firm's List Number style. */
  numbered: { format: string; text: string };
  header: Band | null;
  footer: Band | null;
}

export interface TextLook {
  size: number;
  bold: boolean;
  after: number;
  align: Align;
  caps: boolean;
}

type Align = "left" | "center" | "right";

export interface Band {
  text: string;
  align: Align;
  /** The template shows the page number here. */
  page: boolean;
}

/** A4, 2.54 cm margins, 11 pt sans: the same page our plain .docx uses. */
export const DEFAULT_LOOK: PageLook = {
  width: 595.3,
  height: 841.9,
  margin: { top: 72, right: 72, bottom: 72, left: 72 },
  family: "sans",
  styles: {
    normal: { size: 11, bold: false, after: 8, align: "left", caps: false },
    title: { size: 24, bold: false, after: 8, align: "left", caps: false },
    heading1: { size: 16, bold: true, after: 6, align: "left", caps: false },
    heading2: { size: 14, bold: true, after: 6, align: "left", caps: false },
    heading3: { size: 12, bold: true, after: 6, align: "left", caps: false },
  },
  numbered: { format: "decimal", text: "%1." },
  header: null,
  footer: null,
};

const num = (xml: string | undefined, re: RegExp) => {
  const value = xml ? re.exec(xml)?.[1] : undefined;
  return value === undefined ? null : Number(value);
};

const alignOf = (xml: string | undefined): Align | null => {
  const jc = xml ? /<w:jc w:val="([a-z]+)"/.exec(xml)?.[1] : undefined;
  if (jc === "center") return "center";
  if (jc === "right" || jc === "end") return "right";
  return jc ? "left" : null;
};

const familyOf = (font: string): PageLook["family"] => {
  if (/courier|consolas|mono/i.test(font)) return "mono";
  if (
    /times|georgia|garamond|cambria|antiqua|palatino|century|baskerville|serif|minion/i.test(font)
  ) {
    return "serif";
  }
  return "sans";
};

const SIZE = /<w:sz w:val="(\d+)"/;
const FONT = /w:ascii="([^"]+)"/;

/** The font, page and paragraph choices of a template, as far as a plain PDF can show them. */
export function pageLook(bytes: Uint8Array): PageLook {
  const t = openTemplate(bytes);
  const doc = partText(t.files, t.main) ?? "";
  const sect = doc.slice(Math.max(0, doc.lastIndexOf("<w:sectPr")));
  const twips = (re: RegExp, fallbackPt: number) => {
    const value = num(sect, re);
    return value === null ? fallbackPt : value / 20;
  };
  const stylesPath = relatedPart(t, "styles");
  const stylesXml = (stylesPath && partText(t.files, stylesPath)) || "";
  const styles = stylesOf(stylesXml);
  const defaults = /<w:docDefaults>[\s\S]*?<\/w:docDefaults>/.exec(stylesXml)?.[0];
  const byName = (name: string) => styles.find((s) => s.type === "paragraph" && s.name === name);
  const normal = byName("normal");
  const baseSize = (num(normal?.xml, SIZE) ?? num(defaults, SIZE) ?? 22) / 2;
  const font =
    FONT.exec(normal?.xml ?? "")?.[1] ??
    FONT.exec(defaults ?? "")?.[1] ??
    themeFont(t) ??
    "Calibri";
  const look = (style: StyleInfo | undefined, fallback: TextLook): TextLook => {
    if (!style) return fallback;
    const size = num(style.xml, SIZE);
    const after = num(style.xml, /<w:spacing\b[^>]*w:after="(\d+)"/);
    return {
      size: size === null ? fallback.size : size / 2,
      bold: /<w:b\/>|<w:b w:val="(?:1|true|on)"\/>/.test(style.xml) || fallback.bold,
      after: after === null ? fallback.after : after / 20,
      align: alignOf(style.xml) ?? fallback.align,
      caps: /<w:caps\/>/.test(style.xml),
    };
  };
  const base = DEFAULT_LOOK.styles;
  const normalLook = look(normal, { ...base.normal, size: baseSize });
  return {
    width: twips(/<w:pgSz\b[^>]*w:w="(\d+)"/, DEFAULT_LOOK.width),
    height: twips(/<w:pgSz\b[^>]*w:h="(\d+)"/, DEFAULT_LOOK.height),
    margin: {
      top: twips(/<w:pgMar\b[^>]*w:top="(\d+)"/, 72),
      right: twips(/<w:pgMar\b[^>]*w:right="(\d+)"/, 72),
      bottom: twips(/<w:pgMar\b[^>]*w:bottom="(\d+)"/, 72),
      left: twips(/<w:pgMar\b[^>]*w:left="(\d+)"/, 72),
    },
    family: familyOf(font),
    styles: {
      normal: normalLook,
      title: look(byName("title"), { ...base.title, after: normalLook.after }),
      heading1: look(byName("heading 1"), base.heading1),
      heading2: look(byName("heading 2"), base.heading2),
      heading3: look(byName("heading 3"), base.heading3),
    },
    numbered: listFormat(t, byName("list number")) ?? DEFAULT_LOOK.numbered,
    header: band(t, sect, "header"),
    footer: band(t, sect, "footer"),
  };
}

function themeFont(t: TemplateParts): string | null {
  const theme = relatedPart(t, "theme");
  const xml = theme ? partText(t.files, theme) : null;
  return xml ? (/<a:minorFont>\s*<a:latin typeface="([^"]+)"/.exec(xml)?.[1] ?? null) : null;
}

function listFormat(t: TemplateParts, style: StyleInfo | undefined) {
  const numId = style && /<w:numId w:val="(\d+)"/.exec(style.xml)?.[1];
  const path = relatedPart(t, "numbering");
  const xml = path ? partText(t.files, path) : null;
  if (!numId || !xml) return null;
  const abstract = new RegExp(
    `<w:num\\b[^>]*w:numId="${numId}"[^>]*>[\\s\\S]*?<w:abstractNumId w:val="(\\d+)"`,
  ).exec(xml)?.[1];
  const level = abstract
    ? new RegExp(
        `<w:abstractNum\\b[^>]*w:abstractNumId="${abstract}"[^>]*>[\\s\\S]*?<w:lvl w:ilvl="0"[^>]*>([\\s\\S]*?)</w:lvl>`,
      ).exec(xml)?.[1]
    : undefined;
  const format = level && /<w:numFmt w:val="([A-Za-z]+)"/.exec(level)?.[1];
  const text = level && /<w:lvlText w:val="([^"]*)"/.exec(level)?.[1];
  return format && text !== undefined ? { format, text } : null;
}

function band(t: TemplateParts, sect: string, kind: "header" | "footer"): Band | null {
  const ref = new RegExp(`<w:${kind}Reference\\b[^>]*w:type="default"[^>]*>`).exec(sect)?.[0];
  const id = ref && /r:id="([^"]+)"/.exec(ref)?.[1];
  const rel = relsOf(partText(t.files, t.relsPath)).find((r) => r.id === id);
  if (!rel) return null;
  const path = rel.target.startsWith("/") ? rel.target.slice(1) : `${t.dir}${rel.target}`;
  const xml = partText(t.files, path);
  if (!xml) return null;
  const paras = elements(xml, "w:p").map((e) => xml.slice(e.start, e.end));
  const page = /\bPAGE\b/.test(xml);
  // A page field's cached digit is dropped; the real number is drawn on each page.
  const text = paras
    .map((p) => paragraphText(p.replace(/<w:fldSimple\b[\s\S]*?<\/w:fldSimple>/g, "")).trim())
    .filter(Boolean)
    .join("  ");
  if (!text && !page) return null;
  return { text, align: alignOf(paras[0]) ?? "left", page };
}

const letters = (n: number) => {
  let out = "";
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) {
    out = String.fromCharCode(97 + ((k - 1) % 26)) + out;
  }
  return out;
};

const ROMAN: [number, string][] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

const roman = (n: number) => {
  let out = "";
  let left = n;
  for (const [value, mark] of ROMAN) {
    for (; left >= value; left -= value) out += mark;
  }
  return out;
};

/** The label Word would show for item `n` of a list in this format. */
export function listLabel(format: { format: string; text: string }, n: number): string {
  if (format.format === "bullet") return "•";
  const value: Record<string, () => string> = {
    lowerLetter: () => letters(n),
    upperLetter: () => letters(n).toUpperCase(),
    lowerRoman: () => roman(n),
    upperRoman: () => roman(n).toUpperCase(),
  };
  return format.text.replace("%1", (value[format.format] ?? (() => String(n)))());
}

export interface PdfInput {
  title?: string;
  blocks: readonly Block[];
  author: string;
  date: Date | string;
  footnotes?: readonly string[];
  template?: Uint8Array;
}

const FAMILIES = {
  serif: [
    StandardFonts.TimesRoman,
    StandardFonts.TimesRomanBold,
    StandardFonts.TimesRomanItalic,
    StandardFonts.TimesRomanBoldItalic,
  ],
  sans: [
    StandardFonts.Helvetica,
    StandardFonts.HelveticaBold,
    StandardFonts.HelveticaOblique,
    StandardFonts.HelveticaBoldOblique,
  ],
  mono: [
    StandardFonts.Courier,
    StandardFonts.CourierBold,
    StandardFonts.CourierOblique,
    StandardFonts.CourierBoldOblique,
  ],
} as const;

interface Piece {
  text: string;
  font: PDFFont;
  size: number;
  rise?: number;
}

const LIST_INDENT = 28;

const styleOf = (kind: BlockKind) =>
  kind === "heading1" || kind === "heading2" || kind === "heading3" ? kind : "normal";

/**
 * A PDF of the draft, laid out with the template's page size, margins, font family,
 * sizes, header, footer and list numbering. It uses the PDF's built-in fonts, so the
 * firm's exact typeface is matched by family only; the .docx keeps it exactly.
 */
export async function buildPdf(input: PdfInput): Promise<Uint8Array> {
  const date = new Date(isoSeconds(input.date));
  const look = input.template ? pageLook(input.template) : DEFAULT_LOOK;
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const [regular, bold, italic, boldItalic] = (await Promise.all(
    FAMILIES[look.family].map((name) => pdf.embedFont(name)),
  )) as [PDFFont, PDFFont, PDFFont, PDFFont];
  // The built-in fonts cover Latin-1 and a few marks; anything else shows as "?".
  const known = new Set(regular.getCharacterSet());
  const safe = (text: string) =>
    [...text.replace(/\t/g, "    ").replace(/[\r\n]+/g, " ")]
      .map((ch) => (known.has(ch.codePointAt(0) ?? 0) ? ch : "?"))
      .join("");

  const width = look.width - look.margin.left - look.margin.right;
  const pages: PDFPage[] = [];
  let page = pdf.addPage([look.width, look.height]);
  pages.push(page);
  let y = look.height - look.margin.top;

  const paragraph = (pieces: Piece[], text: TextLook, indent = 0, label?: Piece) => {
    const lineHeight = text.size * 1.25;
    const room = width - indent;
    const lines: Piece[][] = [[]];
    let used = 0;
    for (const piece of pieces) {
      for (const word of piece.text.split(/(\s+)/)) {
        const w = word ? piece.font.widthOfTextAtSize(word, piece.size) : 0;
        if (!word || (used === 0 && !word.trim())) continue;
        if (used + w > room && word.trim()) {
          lines.push([]);
          used = 0;
        }
        lines.at(-1)?.push({ ...piece, text: word });
        used += w;
      }
    }
    lines.forEach((line, i) => {
      if (y - lineHeight < look.margin.bottom) {
        page = pdf.addPage([look.width, look.height]);
        pages.push(page);
        y = look.height - look.margin.top;
      }
      y -= lineHeight;
      const lineWidth = line.reduce((sum, p) => sum + p.font.widthOfTextAtSize(p.text, p.size), 0);
      const shift =
        text.align === "center"
          ? (room - lineWidth) / 2
          : text.align === "right"
            ? room - lineWidth
            : 0;
      let x = look.margin.left + indent + shift;
      if (i === 0 && label) {
        page.drawText(label.text, { x: look.margin.left, y, size: label.size, font: label.font });
      }
      for (const p of line) {
        page.drawText(p.text, { x, y: y + (p.rise ?? 0), size: p.size, font: p.font });
        x += p.font.widthOfTextAtSize(p.text, p.size);
      }
    });
    y -= text.after;
  };

  const runPieces = (block: Block, text: TextLook): Piece[] =>
    block.runs.map((run) => {
      if ("footnote" in run) {
        const size = text.size * 0.65;
        return { text: String(run.footnote), font: regular, size, rise: text.size * 0.35 };
      }
      const strong = run.bold || text.bold;
      const font =
        strong && run.italic ? boldItalic : strong ? bold : run.italic ? italic : regular;
      const words = safe(run.text);
      return { text: text.caps ? words.toUpperCase() : words, font, size: text.size };
    });

  if (input.title) {
    const t = look.styles.title;
    const words = safe(t.caps ? input.title.toUpperCase() : input.title);
    paragraph([{ text: words, font: t.bold ? bold : regular, size: t.size }], t);
  }
  let counter = 0;
  let previous: BlockKind | null = null;
  for (const block of input.blocks) {
    const text = look.styles[styleOf(block.kind)];
    if (block.kind === "numbered") {
      counter = previous === "numbered" ? counter + 1 : 1;
      const label = safe(listLabel(look.numbered, counter));
      paragraph(runPieces(block, text), text, LIST_INDENT, {
        text: label,
        font: regular,
        size: text.size,
      });
    } else if (block.kind === "bullet") {
      paragraph(runPieces(block, text), text, LIST_INDENT, {
        text: "•",
        font: regular,
        size: text.size,
      });
    } else {
      paragraph(runPieces(block, text), text);
    }
    previous = block.kind;
  }
  if (input.footnotes?.length) {
    const small = { ...look.styles.normal, size: look.styles.normal.size * 0.85, after: 2 };
    y -= small.size;
    input.footnotes.forEach((note, i) => {
      paragraph([{ text: safe(`${i + 1}. ${note}`), font: regular, size: small.size }], small);
    });
  }

  // Header and footer go on last, once every page exists.
  const bandSize = look.styles.normal.size * 0.8;
  const drawBand = (b: Band, target: PDFPage, n: number, top: boolean) => {
    const words = safe([b.text, b.page ? String(n) : ""].filter(Boolean).join(" "));
    const w = regular.widthOfTextAtSize(words, bandSize);
    const x =
      b.align === "center"
        ? (look.width - w) / 2
        : b.align === "right"
          ? look.width - look.margin.right - w
          : look.margin.left;
    const at = top ? look.height - look.margin.top / 2 : look.margin.bottom / 2;
    target.drawText(words, { x, y: at, size: bandSize, font: regular });
  };
  pages.forEach((p, i) => {
    if (look.header) drawBand(look.header, p, i + 1, true);
    if (look.footer) drawBand(look.footer, p, i + 1, false);
  });

  if (input.title) pdf.setTitle(input.title);
  pdf.setAuthor(input.author);
  pdf.setProducer("LegalLabs");
  pdf.setCreator("LegalLabs");
  pdf.setCreationDate(date);
  pdf.setModificationDate(date);
  return pdf.save({ useObjectStreams: false });
}
