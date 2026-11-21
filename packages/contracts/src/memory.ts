import { z } from "zod";
import { Id } from "./id.js";

/** Per-user limits on remembered preferences (spec 4.3, 4.4, 3.4). */
export const MEMORY_LIMITS = {
  /** Counted in Unicode code points after trimming. */
  textLength: 1000,
  perUser: 1000,
  candidatesPerTurn: 5,
  pendingCandidates: 20,
  candidateDays: 30,
  /** Rows read from one file. Over the cap is fine: the review shows how many would be skipped. */
  importRows: 5000,
  /** Memories in the prompt for one turn; more than this and the most relevant are picked. */
  selected: 40,
  /** The system block is capped at 8,000 tokens, at 3 characters a token. */
  blockChars: 24_000,
  answers: 2000,
} as const;

/** Codes the memory and writing-style endpoints answer with. */
export const MEMORY_ERROR_CODES = [
  "LIMIT_MEMORIES",
  "LIMIT_MEMORY_LENGTH",
  "LIMIT_STYLE_SAMPLE",
  "STYLE_SAMPLE_UNREADABLE",
] as const;
export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

export const MemorySource = z.enum(["asked", "inferred", "manual", "imported"]);
export type MemorySource = z.infer<typeof MemorySource>;

export const SourcePlatform = z.enum([
  "chatgpt",
  "claude",
  "gemini",
  "copilot",
  "perplexity",
  "other",
]);
export type SourcePlatform = z.infer<typeof SourcePlatform>;

/** Length in Unicode code points, which is what the limit counts. */
export const codePoints = (text: string): number => Array.from(text).length;

/** What a memory is compared by: case, spacing and trailing punctuation never make a new one. */
export function normalizeMemoryText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.!?;:,]+$/u, "")
    .trim();
}

const noNul = (text: string) => !text.includes("\0");

/** Trimmed text with no NUL; the length is checked by the endpoint so it can answer with its own code. */
export const MemoryText = z.string().trim().min(1).refine(noNul, "no NUL bytes");

export const MemoryInput = z.object({ text: MemoryText }).strict();
export type MemoryInput = z.infer<typeof MemoryInput>;

export const Memory = z.object({
  id: Id,
  text: z.string(),
  source: MemorySource,
  created_at: z.string(),
  updated_at: z.string(),
  conflicts_with: z.array(Id).optional(),
});
export type Memory = z.infer<typeof Memory>;

export const MemoryList = z.object({
  items: z.array(Memory),
  count: z.number().int(),
  limit: z.literal(MEMORY_LIMITS.perUser),
  enabled: z.boolean(),
});
export type MemoryList = z.infer<typeof MemoryList>;

export const MemorySettings = z.object({
  use_memory: z.boolean(),
  permitted: z.boolean(),
  pending_candidates: z.number().int(),
});
export type MemorySettings = z.infer<typeof MemorySettings>;

export const MemorySettingsPatch = z.object({ use_memory: z.boolean() }).strict();

export const MemoryCandidate = z.object({
  id: Id,
  text: z.string(),
  from_message_id: Id.nullable(),
  created_at: z.string(),
  expires_at: z.string(),
});
export type MemoryCandidate = z.infer<typeof MemoryCandidate>;

export const AcceptCandidate = z.object({ text: MemoryText.optional() }).strict();

/** The six guided questions; each answer is free text. */
export const PERSONALISE_QUESTIONS = [
  "role",
  "practice_areas",
  "jurisdictions",
  "writing_preferences",
  "citation_preferences",
  "output_format",
] as const;
export const PersonaliseInput = z
  .object({
    answers: z
      .record(z.string().min(1).max(60), z.string().max(MEMORY_LIMITS.answers).refine(noNul))
      .refine((a) => Object.keys(a).length <= 20, "too many answers"),
  })
  .strict();
export type PersonaliseInput = z.infer<typeof PersonaliseInput>;

export const IMPORT_COLUMNS = ["text", "category", "created_at", "source_platform"] as const;

export const ImportRowStatus = z.enum(["ok", "duplicate", "error"]);
export const ImportRow = z.object({
  line: z.number().int(),
  text: z.string(),
  category: z.string().optional(),
  created_at: z.string().optional(),
  source_platform: z.string().optional(),
  status: ImportRowStatus,
  error: z.string().optional(),
});
export type ImportRow = z.infer<typeof ImportRow>;

export const ImportParsed = z.object({
  import_id: Id,
  rows: z.array(ImportRow),
  would_exceed_cap: z.number().int(),
});
export type ImportParsed = z.infer<typeof ImportParsed>;

export const ImportCommit = z
  .object({
    rows: z
      .array(z.object({ line: z.number().int().min(1), text: MemoryText.optional() }).strict())
      .max(MEMORY_LIMITS.importRows),
  })
  .strict();
export type ImportCommit = z.infer<typeof ImportCommit>;

/** The "Memory used" chip, returned only to the author of the answer. */
export const MemoryUse = z.object({
  message_id: Id,
  used: z.array(z.object({ id: Id, text: z.string() })),
  not_applied: z.array(z.object({ id: Id, text: z.string() })),
  /** Memories this message created from "remember that ..."; Undo deletes one. */
  created: z.array(z.object({ id: Id, text: z.string() })),
  writing_style_id: Id.nullable(),
});
export type MemoryUse = z.infer<typeof MemoryUse>;

/**
 * Preferences that exclude each other. Two texts on the same axis with different values
 * disagree. A deliberately small, deterministic list; the model is not asked to judge.
 */
const AXES: readonly { axis: string; values: Record<string, RegExp> }[] = [
  {
    axis: "spelling",
    values: {
      uk: /\b(?:uk|u\.k\.|british|australian|commonwealth)\s+(?:english\s+)?spell|\bspell\w*\b[^.]{0,30}\b(?:uk|british|australian)\b|\b(?:uk|british|australian)\s+english\b/i,
      us: /\b(?:us|u\.s\.|american)\s+(?:english\s+)?spell|\bspell\w*\b[^.]{0,30}\b(?:us|american)\b|\b(?:us|american)\s+english\b/i,
    },
  },
  {
    axis: "oxford_comma",
    values: {
      use: /\b(?:use|with|prefer|add|always)\b[^.]{0,20}\boxford\s+comma/i,
      avoid: /\b(?:no|without|avoid|never|don'?t use|do not use)\b[^.]{0,20}\boxford\s+comma/i,
    },
  },
  {
    axis: "length",
    values: {
      short: /\b(?:concise|brief|short|succinct|terse)\b/i,
      long: /\b(?:detailed|thorough|comprehensive|in[- ]depth|long[- ]form|exhaustive)\b/i,
    },
  },
  {
    axis: "form",
    values: {
      bullets: /\b(?:bullet(?:s|ed)?|list format)\b/i,
      prose: /\b(?:prose|paragraphs?|full sentences)\b/i,
    },
  },
  {
    axis: "tone",
    values: {
      formal: /\b(?:formal|formally|professional tone)\b/i,
      casual: /\b(?:casual|informal|conversational|plain[- ]spoken)\b/i,
    },
  },
];

/** The stance a text takes on each axis, e.g. `{ spelling: "uk" }`. */
export function memoryStances(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const { axis, values } of AXES) {
    const hits = Object.entries(values).filter(([, pattern]) => pattern.test(text));
    // Mentioning both sides is a comparison, not a preference.
    const [only, ...more] = hits;
    if (only && more.length === 0) found[axis] = only[0];
  }
  // "no bullets" mentions bullets but asks for prose; "informal" also reads as formal's opposite.
  if (/\b(?:no|avoid|without|never)\s+bullet/i.test(text)) found.form = "prose";
  if (/\binformal\b/i.test(text)) found.tone = "casual";
  return found;
}

/** True when the two texts take opposite sides on some axis. */
export function memoriesConflict(a: string, b: string): boolean {
  const left = memoryStances(a);
  const right = memoryStances(b);
  return Object.keys(left).some((axis) => right[axis] !== undefined && right[axis] !== left[axis]);
}
