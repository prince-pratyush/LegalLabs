import { findRefs } from "@legallabs/contracts";
import type { ResolvedFile, TableSnapshot } from "./ports.js";

/** What a block hands its successors; kept on the block's step row. */
export type BlockValue =
  | { kind: "text"; text: string }
  | { kind: "empty" }
  | { kind: "select"; ids: string[]; labels: string[] }
  | { kind: "files"; files: ResolvedFile[] }
  | { kind: "table"; table_id: string; title: string; rows_done: number; rows_total: number }
  | { kind: "snapshot"; snapshot: TableSnapshot }
  | { kind: "branches"; taken: string[] };

export const SKIPPED = "(skipped)";
export const NOT_PROVIDED = "(not provided)";
export const TRUNCATED = "[truncated]";
// Per reference, so one long input can't crowd every other one out of the prompt.
export const MAX_INLINE_CHARS = 50_000;
const SNAPSHOT_ROWS = 200;

/** A referenced block as it reads in a prompt, and what it attaches as context. */
export interface Resolved {
  inline: string;
  documents: ResolvedFile[];
  tables: string[];
  truncated: boolean;
}

const cell = (v: unknown) =>
  String(typeof v === "string" ? v : (JSON.stringify(v) ?? "")).replaceAll("|", "\\|");

export function resolveValue(value: BlockValue | null): Resolved {
  const none = { documents: [], tables: [], truncated: false };
  if (value === null) return { inline: SKIPPED, ...none };
  switch (value.kind) {
    case "empty":
      return { inline: NOT_PROVIDED, ...none };
    case "text": {
      const long = value.text.length > MAX_INLINE_CHARS;
      const text = long ? `${value.text.slice(0, MAX_INLINE_CHARS)} ${TRUNCATED}` : value.text;
      return { inline: text, documents: [], tables: [], truncated: long };
    }
    case "select":
      return { inline: value.labels.join(", ") || NOT_PROVIDED, ...none };
    case "files":
      return {
        inline: value.files.map((f) => f.name).join(", ") || NOT_PROVIDED,
        documents: value.files,
        tables: [],
        truncated: false,
      };
    case "table":
      return {
        inline: `the review table "${value.title}"`,
        documents: [],
        tables: [value.table_id],
        truncated: false,
      };
    case "snapshot": {
      const { columns, rows } = value.snapshot;
      const lines = [
        `| ${columns.map(cell).join(" | ")} |`,
        `| ${columns.map(() => "---").join(" | ")} |`,
        ...rows
          .slice(0, SNAPSHOT_ROWS)
          .map((r) => `| ${columns.map((c) => cell(r[c])).join(" | ")} |`),
      ];
      const truncated = rows.length > SNAPSHOT_ROWS;
      if (truncated) lines.push(TRUNCATED);
      return { inline: lines.join("\n"), documents: [], tables: [], truncated };
    }
    case "branches":
      return { inline: value.taken.join(", "), ...none };
  }
}

/** Replaces each `@Label` with the referenced block's output; unknown tokens stay as typed. */
export function substitute(
  text: string,
  labels: readonly string[],
  lookup: (label: string) => Resolved,
): Resolved {
  let out = text;
  const documents: ResolvedFile[] = [];
  const tables: string[] = [];
  let truncated = false;
  // From the end, so earlier indexes stay right as lengths change.
  for (const ref of findRefs(text, labels).reverse()) {
    if (ref.label === null) continue;
    const r = lookup(ref.label);
    out = out.slice(0, ref.index) + r.inline + out.slice(ref.index + ref.raw.length);
    documents.push(...r.documents);
    tables.push(...r.tables);
    truncated ||= r.truncated;
  }
  return { inline: out, documents: dedupe(documents), tables: [...new Set(tables)], truncated };
}

export function dedupe(files: ResolvedFile[]): ResolvedFile[] {
  const seen = new Set<string>();
  return files.filter((f) => !seen.has(f.version_id) && !!seen.add(f.version_id));
}
