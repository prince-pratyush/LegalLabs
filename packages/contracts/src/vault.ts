import { z } from "zod";

/** Levels a vault can be shared at; the owner is above all three. */
export const VaultLevel = z.enum(["view", "edit", "full"]);
export type VaultLevel = z.infer<typeof VaultLevel>;

export const VaultAccess = z.enum(["view", "edit", "full", "owner"]);
export type VaultAccess = z.infer<typeof VaultAccess>;

/** The most a workspace may allow; an admin can only lower these. */
export const VAULT_LIMITS = { files: 100_000, bytes: 100 * 1024 ** 3 } as const;

const MB = 1024 ** 2;

// By extension, for files the ingest pipeline can read today.
export const FILE_TYPE_LIMITS: Record<string, { kind: string; bytes: number }> = {
  pdf: { kind: "document", bytes: 500 * MB },
  docx: { kind: "document", bytes: 500 * MB },
  md: { kind: "document", bytes: 500 * MB },
  markdown: { kind: "document", bytes: 500 * MB },
  txt: { kind: "document", bytes: 30 * MB },
  xlsx: { kind: "spreadsheet", bytes: 20 * MB },
  eml: { kind: "email", bytes: 500 * MB },
  msg: { kind: "email", bytes: 500 * MB },
  pst: { kind: "mailbox", bytes: 4 * 1024 * MB },
};

/** The limit for a file name, or null for a type that can't be read. */
export function fileTypeLimit(name: string): { kind: string; bytes: number } | null {
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(FILE_TYPE_LIMITS, extension) ? (FILE_TYPE_LIMITS[extension] ?? null) : null;
}

export const UploadRejection = z.enum([
  "FILE_TOO_LARGE",
  "UNSUPPORTED_TYPE",
  "VAULT_FILE_LIMIT",
  "VAULT_SIZE_LIMIT",
]);
export type UploadRejection = z.infer<typeof UploadRejection>;

/** What a person sees for a file while it is read. */
export const FileState = z.enum(["queued", "processing", "ready", "failed"]);
export type FileState = z.infer<typeof FileState>;

export const ContentControls = z
  .object({
    allow_download: z.boolean(),
    allow_duplicate: z.boolean(),
    show_review_prompts: z.boolean(),
  })
  .strict();
export type ContentControls = z.infer<typeof ContentControls>;

export const VaultGrant = z
  .object({
    principal_type: z.enum(["user", "group"]),
    principal_id: z.uuid(),
    level: VaultLevel,
  })
  .strict();
export type VaultGrant = z.infer<typeof VaultGrant>;

/** At least three hours, or null to keep files until someone deletes them. */
export const RetentionHours = z.number().int().min(3).max(1_000_000).nullable();
