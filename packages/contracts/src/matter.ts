import { z } from "zod";
import { Id } from "./id.js";
import { WallMode } from "./wall.js";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !value.includes("\0"), "Postgres text cannot hold a NUL byte");
const required = (max: number) => text(max).pipe(z.string().min(1));

export const MATTER_LIMITS = {
  importRows: 50_000,
  importBytes: 20 * 1024 * 1024,
  previewIssues: 50,
  /** A walls file is refused outright when more than this share of its rows can't be resolved. */
  wallUnresolvedShare: 0.1,
} as const;

export const MatterStatus = z.enum(["active", "closed"]);
export type MatterStatus = z.infer<typeof MatterStatus>;
export const MatterSource = z.enum(["manual", "csv", "api", "intapp", "imanage"]);
export type MatterSource = z.infer<typeof MatterSource>;

export const ModelPolicy = z
  .object({
    deny_providers: z.array(text(100)).max(50),
    deny_models: z.array(text(200)).max(200),
  })
  .strict();
export type ModelPolicy = z.infer<typeof ModelPolicy>;

/** A matter as every endpoint returns it; `display` is always formatted by the server. */
export const Matter = z.object({
  id: Id,
  client_id: z.string().max(64),
  client_name: z.string().max(200),
  matter_number: z.string().max(64),
  matter_name: z.string().max(200),
  description: z.string().max(2000),
  notice_md: z.string().max(5000).nullable(),
  notice_version: z.number().int(),
  wall_mode: WallMode,
  allow_in_queries: z.boolean(),
  retention_hours: z.number().int().min(3).nullable(),
  require_walls_for_sharing: z.boolean(),
  model_policy: ModelPolicy.nullable(),
  status: MatterStatus,
  source: MatterSource,
  external_ref: z.string().nullable(),
  display: z.string(),
  space_id: Id.nullable(),
  /** Whether the caller has acknowledged the current notice; true when there is none. */
  acknowledged: z.boolean(),
  /** Admins only. */
  walls_count: z.number().int().optional(),
});
export type Matter = z.infer<typeof Matter>;

export const MatterCreate = z
  .object({
    client_id: required(64),
    client_name: required(200),
    matter_number: required(64),
    matter_name: required(200),
    description: text(2000).optional(),
    notice_md: text(5000).nullable().optional(),
    wall_mode: WallMode.optional(),
    allow_in_queries: z.boolean().optional(),
    retention_hours: z.number().int().min(3).max(876_000).nullable().optional(),
    require_walls_for_sharing: z.boolean().optional(),
    model_policy: ModelPolicy.nullable().optional(),
    external_ref: text(200).nullable().optional(),
  })
  .strict();
export type MatterCreate = z.infer<typeof MatterCreate>;

export const MatterPatch = MatterCreate.partial().strict();
export type MatterPatch = z.infer<typeof MatterPatch>;

export const DisplayFormat = z
  .object({
    separator: z.string().max(3),
    show_client_id: z.boolean(),
    show_client_name: z.boolean(),
    show_description: z.boolean(),
  })
  .strict();
export type DisplayFormat = z.infer<typeof DisplayFormat>;

export const VaultAssociation = z.enum(["disabled", "optional", "required"]);
export type VaultAssociation = z.infer<typeof VaultAssociation>;

const regex = text(200).refine((source) => {
  try {
    new RegExp(source, "u");
    return true;
  } catch {
    return false;
  }
}, "Enter a valid regular expression.");

export const MatterOptions = z
  .object({
    require_for_queries: z.boolean(),
    user_editable: z.boolean(),
    vault_association: VaultAssociation,
    display_format: DisplayFormat,
    id_regex: regex.nullable(),
    sharing_warning: text(200).nullable(),
    allow_matter_mismatch_in_spaces: z.boolean(),
  })
  .strict();
export type MatterOptions = z.infer<typeof MatterOptions>;

export const DEFAULT_MATTER_OPTIONS: MatterOptions = {
  require_for_queries: false,
  user_editable: false,
  vault_association: "optional",
  display_format: {
    separator: "-",
    show_client_id: true,
    show_client_name: false,
    show_description: false,
  },
  id_regex: null,
  sharing_warning: null,
  allow_matter_mismatch_in_spaces: false,
};

/** `{client_id}{sep}{matter_number}`, then the name and description when the format asks. */
export function matterDisplay(
  matter: Pick<Matter, "client_id" | "client_name" | "matter_number" | "description">,
  format: DisplayFormat,
): string {
  const id = format.show_client_id
    ? `${matter.client_id}${format.separator}${matter.matter_number}`
    : matter.matter_number;
  return [
    id,
    format.show_client_name ? matter.client_name : "",
    format.show_description ? matter.description : "",
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}

/** Whether a matter number passes the workspace's id pattern; no pattern passes everything. */
export function matterNumberValid(matterNumber: string, idRegex: string | null): boolean {
  if (!idRegex) return true;
  try {
    return new RegExp(idRegex, "u").test(matterNumber);
  } catch {
    return false;
  }
}

export const ImportMode = z.enum(["upsert", "replace_missing_as_closed"]);
export type ImportMode = z.infer<typeof ImportMode>;

export const MatterImportIssue = z.object({
  /** 1-based, counting the header as line 1. */
  line: z.number().int(),
  column: z.string().nullable(),
  message: z.string(),
});
export type MatterImportIssue = z.infer<typeof MatterImportIssue>;

export const ImportPreview = z.object({
  token: Id,
  add: z.number().int(),
  update: z.number().int(),
  close: z.number().int(),
  unchanged: z.number().int(),
  issue_count: z.number().int(),
  issues: z.array(MatterImportIssue).max(MATTER_LIMITS.previewIssues),
});
export type ImportPreview = z.infer<typeof ImportPreview>;

export const ImportApplied = z.object({
  applied: z.object({ add: z.number().int(), update: z.number().int(), close: z.number().int() }),
  /** The uploaded rows with a `result` column, as CSV. */
  report_csv: z.string(),
});
export type ImportApplied = z.infer<typeof ImportApplied>;

export const WallPrincipalType = z.enum(["user", "group"]);
export const WallEffect = z.enum(["allow", "deny"]);
export const WallProviderKind = z.enum(["internal", "csv", "intapp", "imanage_spm"]);
export type WallProviderKind = z.infer<typeof WallProviderKind>;
/** Providers that can be chosen today; the others are reserved for connectors. */
export const SUPPORTED_WALL_PROVIDERS: readonly WallProviderKind[] = ["internal", "csv"];

export const WallRow = z.object({
  id: Id,
  matter_id: Id,
  matter_display: z.string(),
  principal_type: WallPrincipalType,
  principal_id: Id,
  principal_label: z.string(),
  effect: WallEffect,
  provider: WallProviderKind,
  synced_at: z.string().nullable(),
  created_at: z.string(),
});
export type WallRow = z.infer<typeof WallRow>;

export const WallCreate = z
  .object({
    matter_id: Id,
    principal_type: WallPrincipalType,
    principal_id: Id,
    effect: WallEffect,
  })
  .strict();
export type WallCreate = z.infer<typeof WallCreate>;

export const WallCsvChange = z.object({
  matter_display: z.string(),
  principal_type: WallPrincipalType,
  principal: z.string(),
  effect: WallEffect,
});
export type WallCsvChange = z.infer<typeof WallCsvChange>;

export const WallCsvPreview = z.object({
  token: Id.nullable(),
  /** False when too many rows failed; nothing can be applied. */
  accepted: z.boolean(),
  matters: z.number().int(),
  add: z.array(WallCsvChange),
  remove: z.array(WallCsvChange),
  unchanged: z.number().int(),
  rows: z.number().int(),
  unresolved: z.array(MatterImportIssue),
});
export type WallCsvPreview = z.infer<typeof WallCsvPreview>;

export const WallProviderConfig = z
  .object({
    kind: WallProviderKind,
    config: z.record(z.string(), z.unknown()).default({}),
    cadence_minutes: z.number().int().min(1).max(60).nullable().default(null),
    secret_ref: text(500).nullable().default(null),
  })
  .strict();
export type WallProviderConfig = z.infer<typeof WallProviderConfig>;

export const WallSyncReport = z.object({
  id: Id,
  provider: WallProviderKind,
  started_at: z.string(),
  finished_at: z.string().nullable(),
  status: z.enum(["running", "ok", "failed", "partial"]),
  matters: z.number().int(),
  rows_added: z.number().int(),
  rows_removed: z.number().int(),
  unresolved: z.array(MatterImportIssue),
});
export type WallSyncReport = z.infer<typeof WallSyncReport>;

export const WallReason = z.enum(["no_matter", "deny", "not_allow_listed", "allowed", "open"]);
export type WallReason = z.infer<typeof WallReason>;

export const WallEvaluateRequest = z.object({ user_id: Id, matter_id: Id.nullable() }).strict();
export const WallEvaluation = z.object({
  allowed: z.boolean(),
  reason: WallReason,
  matched_rules: z.array(
    z.object({
      id: Id,
      matter_id: Id,
      principal_type: WallPrincipalType,
      principal_id: Id,
      effect: WallEffect,
      provider: WallProviderKind,
    }),
  ),
});
export type WallEvaluation = z.infer<typeof WallEvaluation>;
