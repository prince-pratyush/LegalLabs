import {
  TRANSLATE_LIMITS,
  TRANSLATION_LANGUAGES,
  type TranslationLanguage,
} from "@legallabs/contracts";
import { buildDocx, openText } from "@legallabs/docx";
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
    async translate({ workspaceId, texts, language: into, exclude, signal }) {
      const done = await language.translate(workspaceId, texts, TRANSLATION_LANGUAGES[into], {
        exclude,
        ...(signal ? { signal } : {}),
      });
      return done.ok ? { translated: done.value, costUsd: done.costUsd ?? 0 } : null;
    },
  };
}

// One request never spends more than this, however many batches it has.
const MAX_COST_USD = 2;
const WORDS = /\p{L}/u;

/** Translates in batches, keeping the space around each piece and skipping what has no words. */
export async function translateAll(
  translator: Translator,
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
  while (at < wanted.length && costUsd < MAX_COST_USD && !stopped()) {
    const batch = [wanted[at] as (typeof wanted)[number]];
    let chars = batch[0]?.text.length ?? 0;
    for (const next of wanted.slice(at + 1, at + MAX_BATCH_PARAGRAPHS)) {
      if (chars + next.text.length > MAX_BATCH_CHARS) break;
      batch.push(next);
      chars += next.text.length;
    }
    at += batch.length;
    const result = await translator.translate({ ...request, texts: batch.map((b) => b.text) });
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
  build(translated: readonly (string | null)[]): Uint8Array;
}

const TEXT_MIMES = new Set(["application/pdf", "text/plain", "text/markdown"]);

/**
 * The words of a version. A .docx is translated inside its own file, keeping its layout; a PDF or
 * text file becomes a plain .docx made from the pages ingest read.
 */
export async function loadTranslatable(
  db: pg.PoolClient,
  store: ObjectStore | undefined,
  meta: VersionMeta,
): Promise<Translatable | "UNSUPPORTED_TYPE" | "NOT_READY"> {
  const base = { documentId: meta.documentId, name: meta.name };
  if (meta.mime === DOCX) {
    const bytes = await store?.get(contentKey(meta.workspaceId, meta.sha256.toString("hex")));
    if (!bytes) return "NOT_READY";
    try {
      // Opened again to write, so ten files' unpacked parts aren't all held while translating.
      return {
        ...base,
        texts: openText(bytes).segments,
        build: (translated) => openText(bytes).apply(translated),
      };
    } catch {
      return "UNSUPPORTED_TYPE";
    }
  }
  if (!TEXT_MIMES.has(meta.mime)) return "UNSUPPORTED_TYPE";
  const { rows } = await db.query<{ text: string }>(
    // Bounded before it is split: anything longer is refused for its length anyway.
    `select left(text, $2) as text from content.page where version_id = $1
      order by page_no limit 2000`,
    [meta.versionId, TRANSLATE_LIMITS.totalChars + 1],
  );
  if (rows.length === 0) return "NOT_READY";
  const texts = pageParagraphs(rows.map((r) => r.text));
  return {
    ...base,
    texts,
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

/** Models the matter leaves usable; `none` when it leaves nothing. */
export async function modelsFor(db: pg.PoolClient, gateway: Gateway, matterId: string | null) {
  const all = gateway.models("draft_edit").map((m) => m.id);
  const { rows } = matterId
    ? await db.query<{
        model_policy: { deny_providers?: string[]; deny_models?: string[] } | null;
      }>("select model_policy from core.matter where id = $1", [matterId])
    : { rows: [] };
  const policy = rows[0]?.model_policy;
  const exclude = all.filter((id) => {
    const [provider = "", ...name] = id.split("/");
    return (
      policy?.deny_providers?.includes(provider) ||
      policy?.deny_models?.includes(id) ||
      policy?.deny_models?.includes(name.join("/"))
    );
  });
  return { exclude, none: all.length > 0 && exclude.length === all.length };
}
