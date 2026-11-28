import {
  TRANSLATE_LIMITS,
  TRANSLATION_LANGUAGES,
  type TranslationLanguage,
} from "@legallabs/contracts";
import { buildDocx, DocxError, openText } from "@legallabs/docx";
import type { Gateway } from "@legallabs/model-gateway";
import { contentKey, type ObjectStore } from "@legallabs/storage";
import type pg from "pg";
import { createLanguage, MAX_BATCH_CHARS, MAX_BATCH_PARAGRAPHS } from "../addins/language.js";
import { DOCX, pageParagraphs, type VersionMeta } from "../reviews/source.js";

export interface TranslateRequest {
  workspaceId: string;
  texts: string[];
  language: TranslationLanguage;
  /** Models a matter keeps this material from. */
  exclude: readonly string[];
  signal?: AbortSignal;
  /** What is left of the request's budget; a call that could cost more is not made. */
  maxCostUsd: number;
}

/**
 * Where the words are sent. The only one built in uses the workspace's own models, so nothing
 * goes to a translation service.
 */
export interface Translator {
  /** One entry per text, null where nothing usable came back; null when it can't be done at all. */
  translate(
    request: TranslateRequest,
  ): Promise<{ translated: (string | null)[]; costUsd: number } | null>;
}

export function modelTranslator(gateway: Gateway): Translator {
  const language = createLanguage(gateway);
  return {
    async translate({ workspaceId, texts, language: into, exclude, signal, maxCostUsd }) {
      const done = await language.translate(workspaceId, texts, TRANSLATION_LANGUAGES[into], {
        exclude,
        maxCostUsd,
        ...(signal ? { signal } : {}),
      });
      return done.ok ? { translated: done.value, costUsd: done.costUsd ?? 0 } : null;
    },
  };
}

// One request never spends more than this, however many files and batches it has.
export const MAX_TRANSLATION_USD = 2;
const WORDS = /\p{L}/u;

/** Translates in batches, keeping the space around each piece and skipping what has no words. */
export async function translateAll(
  translator: Translator,
  /** `maxCostUsd` here is what is left for the whole request. */
  request: TranslateRequest,
  stopped: () => boolean,
): Promise<{ translated: (string | null)[]; missing: number; costUsd: number }> {
  const wanted = request.texts.flatMap((text, i) =>
    WORDS.test(text) ? [{ i, text: text.trim() }] : [],
  );
  const translated: (string | null)[] = request.texts.map(() => null);
  let costUsd = 0;
  let done = 0;
  let at = 0;
  while (at < wanted.length && costUsd < request.maxCostUsd && !stopped()) {
    const batch = [wanted[at] as (typeof wanted)[number]];
    let chars = batch[0]?.text.length ?? 0;
    for (const next of wanted.slice(at + 1, at + MAX_BATCH_PARAGRAPHS)) {
      if (chars + next.text.length > MAX_BATCH_CHARS) break;
      batch.push(next);
      chars += next.text.length;
    }
    at += batch.length;
    const result = await translator.translate({
      ...request,
      texts: batch.map((b) => b.text),
      maxCostUsd: request.maxCostUsd - costUsd,
    });
    if (!result) break;
    costUsd += result.costUsd;
    batch.forEach((item, n) => {
      const words = result.translated[n]
        ?.replaceAll("\0", "")
        .replace(/\s*[\r\n]\s*/g, " ")
        .trim();
      if (!words) return;
      const original = request.texts[item.i] as string;
      const before = original.slice(0, original.length - original.trimStart().length);
      const after = original.slice(original.trimEnd().length);
      translated[item.i] = `${before}${words}${after}`;
      done++;
    });
  }
  return { translated, missing: wanted.length - done, costUsd };
}

export interface Translatable {
  documentId: string;
  name: string;
  texts: string[];
  /** XML parsed for it, bounded across the files of one request. */
  xmlBytes: number;
  build(translated: readonly (string | null)[]): Uint8Array;
}

const TEXT_MIMES = new Set(["application/pdf", "text/plain", "text/markdown"]);

/** Whether a file of this type can be translated at all. */
export const translatable = (mime: string) => mime === DOCX || TEXT_MIMES.has(mime);

/**
 * The page text of a PDF or text file, measured before it is fetched; null when it alone is more
 * than a request may translate.
 */
export async function pagesToTranslate(db: pg.PoolClient, versionId: string) {
  const { rows: size } = await db.query<{ chars: string }>(
    "select coalesce(sum(char_length(text)), 0) chars from content.page where version_id = $1",
    [versionId],
  );
  if (Number(size[0]?.chars) > TRANSLATE_LIMITS.totalChars) return null;
  const { rows } = await db.query<{ text: string }>(
    "select text from content.page where version_id = $1 order by page_no",
    [versionId],
  );
  return rows.map((row) => row.text);
}

export type Unreadable = "UNSUPPORTED_TYPE" | "ACTIVE_CONTENT" | "LIMIT_FILE_SIZE" | "NOT_READY";

/**
 * The words of a version that was scanned and accepted. A .docx is translated inside its own file,
 * keeping its layout; a PDF or text file becomes a plain .docx made from the pages ingest read.
 * Called outside any transaction: unpacking and parsing take time.
 */
export async function loadTranslatable(
  store: ObjectStore | undefined,
  meta: VersionMeta,
  pages: readonly string[],
): Promise<Translatable | Unreadable> {
  const base = { documentId: meta.documentId, name: meta.name };
  if (meta.mime === DOCX) {
    const bytes = await store?.get(contentKey(meta.workspaceId, meta.sha256.toString("hex")));
    if (!bytes) return "NOT_READY";
    try {
      const open = openText(bytes);
      // Opened again to write, so ten files' unpacked parts aren't all held while translating.
      return {
        ...base,
        texts: open.segments,
        xmlBytes: open.xmlBytes,
        build: (translated) => openText(bytes).apply(translated),
      };
    } catch (err) {
      if (!(err instanceof DocxError)) throw err;
      if (err.code === "ACTIVE_CONTENT") return "ACTIVE_CONTENT";
      return err.code === "TOO_LARGE" ? "LIMIT_FILE_SIZE" : "UNSUPPORTED_TYPE";
    }
  }
  const texts = pageParagraphs(pages);
  return {
    ...base,
    texts,
    xmlBytes: 0,
    build: (translated) =>
      buildDocx({
        blocks: texts.map((text, i) => ({
          kind: "paragraph" as const,
          runs: [{ text: translated[i] ?? text }],
        })),
        author: "LegalLabs",
        date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      }),
  };
}

export const translatedName = (name: string, language: TranslationLanguage) =>
  `${[...name.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]+/gu, " ")].slice(0, 150).join("").trim() || "File"} (${language}).docx`;
