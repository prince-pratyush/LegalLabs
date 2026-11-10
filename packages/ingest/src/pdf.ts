import { getDocument, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Block, Failure, Limits, Page } from "./process.js";

interface Item {
  str: string;
  transform: number[];
  width: number;
}

interface Line {
  text: string;
  baseline: number;
  height: number;
  x0: number;
  x1: number;
}

// Postgres can't store NUL, and control characters would only corrupt offsets later.
export const cleanText = (text: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  text.replace(/[\0-\x08\x0b\x0c\x0e-\x1f]/g, "").toWellFormed();

const round = (value: number) => Math.round(value * 100) / 100;

// A file can claim any size, and Postgres refuses a float it can't hold.
const isUsableSize = (points: number) => points >= 1 && points <= 1_000_000;

function linesOf(items: readonly Item[], pageTransform: number[]): Line[] {
  const lines: Line[] = [];
  for (const item of items) {
    const str = cleanText(item.str);
    if (str === "") continue;
    const placed = Util.transform(pageTransform, item.transform);
    const x = placed[4] as number;
    const baseline = placed[5] as number;
    const height = Math.hypot(placed[2] as number, placed[3] as number) || 1;
    const line = lines.at(-1);
    if (line && Math.abs(baseline - line.baseline) <= line.height / 2) {
      const gap = x - line.x1 > height * 0.15 && !line.text.endsWith(" ") && !str.startsWith(" ");
      line.text += (gap ? " " : "") + str;
      line.x1 = Math.max(line.x1, x + item.width);
      line.height = Math.max(line.height, height);
    } else if (str.trim() !== "") {
      lines.push({ text: str, baseline, height, x0: x, x1: x + item.width });
    }
  }
  return lines;
}

function assemble(lines: readonly Line[]): { text: string; blocks: Block[] } {
  let text = "";
  const blocks: Block[] = [];
  let previous: Line | undefined;
  for (const line of lines) {
    const content = line.text.trimEnd();
    if (previous) {
      const drop = line.baseline - previous.baseline;
      text += drop < 0 || drop > 1.6 * Math.max(line.height, previous.height) ? "\n\n" : "\n";
    }
    const from = text.length;
    text += content;
    blocks.push({
      from,
      to: text.length,
      x0: round(line.x0),
      y0: round(line.baseline - line.height),
      x1: round(line.x1),
      y1: round(line.baseline),
    });
    previous = line;
  }
  return { text, blocks };
}

export async function readPdf(bytes: Uint8Array, limits: Limits): Promise<Page[] | Failure> {
  const task = getDocument({
    data: bytes.slice(), // pdf.js takes ownership of what it is given
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > limits.maxPages) return "PAGE_LIMIT_EXCEEDED";
    const pages: Page[] = [];
    let chars = 0;
    let lines = 0;
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      if (!isUsableSize(viewport.width) || !isUsableSize(viewport.height)) return "CORRUPT_FILE";
      const content = await page.getTextContent();
      const items = content.items.flatMap((item) => ("str" in item ? [item] : []));
      const { text, blocks } = assemble(linesOf(items, viewport.transform));
      chars += text.length;
      lines += blocks.length;
      if (chars > limits.maxChars || lines > limits.maxBlocks) return "PAGE_LIMIT_EXCEEDED";
      pages.push({ pageNo, width: viewport.width, height: viewport.height, text, blocks });
      page.cleanup();
    }
    return pages;
  } catch (err) {
    return err instanceof Error && err.name === "PasswordException"
      ? "ENCRYPTED_NO_PASSWORD"
      : "CORRUPT_FILE";
  } finally {
    await task.destroy();
  }
}
