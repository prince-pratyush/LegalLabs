import { z } from "zod";
import { Id } from "./id.js";
import { ColumnType, RT_LIMITS, Settings } from "./review-table.js";

const noNul = (text: string) => !text.includes("\0");
const text = (max: number) => z.string().max(max).refine(noNul, "Text cannot hold a NUL byte");

export const TEMPLATE_LIMITS = {
  name: 120,
  description: 1_000,
  tags: 20,
  tagChars: 60,
  testDocuments: 10,
  shares: 100,
} as const;

/** Where a template is in its life. `superseded` is a published version a newer one replaced. */
export const TemplateStatus = z.enum([
  "draft",
  "tested",
  "shared",
  "pending_approval",
  "published",
  "rejected",
  "superseded",
]);
export type TemplateStatus = z.infer<typeof TemplateStatus>;

/** A column as a template keeps it: no id, and `@{key}` in a prompt names another column's key. */
export const ColumnDef = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,19}$/),
    label: text(RT_LIMITS.labelChars).pipe(z.string().trim().min(1)),
    type: ColumnType,
    prompt: text(RT_LIMITS.promptChars),
    language: z.string().min(2).max(35).nullable().optional(),
    /** Only when the author pinned a model; otherwise the table's own choice applies. */
    model: z.string().min(1).max(200).nullable().optional(),
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type ColumnDef = z.infer<typeof ColumnDef>;

const Columns = z
  .array(ColumnDef)
  .max(RT_LIMITS.columns)
  .refine((list) => new Set(list.map((c) => c.key)).size === list.length, "Keys repeat");

const Tags = z.array(text(TEMPLATE_LIMITS.tagChars).pipe(z.string().trim().min(1))).max(
  TEMPLATE_LIMITS.tags,
);

export const TemplateAccess = z.enum(["owner", "edit", "use"]);
export type TemplateAccess = z.infer<typeof TemplateAccess>;

export const ReviewTableTemplate = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  categories: z.array(z.string()),
  document_tags: z.array(z.string()),
  columns: z.array(ColumnDef),
  settings: Settings,
  status: TemplateStatus,
  version: z.number().int(),
  parent_id: Id.nullable(),
  builtin: z.boolean(),
  owner_id: Id,
  approved_by: Id.nullable(),
  rejected_note: z.string().nullable(),
  my_access: TemplateAccess,
  created_at: z.string(),
  updated_at: z.string(),
});
export type ReviewTableTemplate = z.infer<typeof ReviewTableTemplate>;

/** Save a table's columns, instructions and settings; never its rows, cells or source. */
export const SaveTemplateBody = z
  .object({
    name: text(TEMPLATE_LIMITS.name).pipe(z.string().trim().min(1)),
    description: text(TEMPLATE_LIMITS.description).default(""),
    instructions: text(RT_LIMITS.instructionsChars).optional(),
    categories: Tags.default([]),
    document_tags: Tags.default([]),
  })
  .strict();
export type SaveTemplateBody = z.infer<typeof SaveTemplateBody>;

export const PatchTemplateBody = z
  .object({
    name: text(TEMPLATE_LIMITS.name).pipe(z.string().trim().min(1)).optional(),
    description: text(TEMPLATE_LIMITS.description).optional(),
    instructions: text(RT_LIMITS.instructionsChars).optional(),
    categories: Tags.optional(),
    document_tags: Tags.optional(),
    columns: Columns.optional(),
    settings: Settings.partial().optional(),
  })
  .strict();
export type PatchTemplateBody = z.infer<typeof PatchTemplateBody>;

export const TemplateGrant = z
  .object({
    principal_type: z.enum(["user", "group", "workspace"]),
    principal_id: Id,
    level: z.enum(["use", "edit"]),
  })
  .strict();
export type TemplateGrant = z.infer<typeof TemplateGrant>;

export const PutTemplateSharesBody = z
  .object({ grants: z.array(TemplateGrant).max(TEMPLATE_LIMITS.shares) })
  .strict();
export type PutTemplateSharesBody = z.infer<typeof PutTemplateSharesBody>;

/** Try a template on a few files of a vault: makes a table that is deleted after a week. */
export const TestTemplateBody = z
  .object({
    vault_id: Id,
    document_ids: z.array(Id).min(1).max(TEMPLATE_LIMITS.testDocuments),
  })
  .strict();
export type TestTemplateBody = z.infer<typeof TestTemplateBody>;

export const DecideTemplateBody = z
  .object({ note: text(1_000).optional() })
  .strict();
export type DecideTemplateBody = z.infer<typeof DecideTemplateBody>;

const KEY_MENTION = /@\{([a-z][a-z0-9_]{0,19})\}/g;

/** Keys for a table's columns, in order: c1, c2, … */
export const columnKeys = (count: number) => Array.from({ length: count }, (_, i) => `c${i + 1}`);

/** A prompt with each `@{column_id}` written as `@{key}`, so it survives being copied. */
export function templatizePrompt(prompt: string, keyOfId: ReadonlyMap<string, string>): string {
  return prompt.replace(
    /@\{([0-9a-fA-F-]{36})\}/g,
    (whole, id: string) => (keyOfId.has(id.toLowerCase()) ? `@{${keyOfId.get(id.toLowerCase())}}` : whole),
  );
}

/** The reverse: `@{key}` becomes `@{column_id}` once the template's columns have ids. */
export function instantiatePrompt(prompt: string, idOfKey: ReadonlyMap<string, string>): string {
  return prompt.replace(KEY_MENTION, (whole, key: string) =>
    idOfKey.has(key) ? `@{${idOfKey.get(key)}}` : whole,
  );
}

/** The keys a template prompt refers to. */
export function templateReferences(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(KEY_MENTION)].map((m) => m[1] ?? ""))];
}

/** Template columns in an order where each follows the ones it uses; null if they go in a circle. */
export function templateOrder(columns: readonly ColumnDef[]): ColumnDef[] | null {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const done = new Set<string>();
  const ordered: ColumnDef[] = [];
  let rest = [...columns];
  while (rest.length > 0) {
    const ready = rest.filter((c) =>
      templateReferences(c.prompt).every((k) => done.has(k) || !byKey.has(k)),
    );
    if (ready.length === 0) return null;
    for (const c of ready) {
      ordered.push(c);
      done.add(c.key);
    }
    rest = rest.filter((c) => !ready.includes(c));
  }
  return ordered;
}

export const TemplateErrorCode = z.enum([
  "TEMPLATE_NOT_FOUND",
  "TEMPLATE_BAD_TRANSITION",
  "TEMPLATE_INVALID",
]);
export type TemplateErrorCode = z.infer<typeof TemplateErrorCode>;
