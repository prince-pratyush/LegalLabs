import { z } from "zod";
import { Id } from "./id.js";

// Limits from review-tables.md §4, shared so the API and the web app refuse the same things.
export const RT_LIMITS = {
  vaultDocuments: 10_000,
  uploads: 50,
  columns: 500,
  documentsPerRow: 25,
  labelChars: 80,
  promptChars: 4_000,
  instructionsChars: 4_000,
  classifyOptions: 20,
  proposals: 30,
  runningColumns: 3,
  dryRunRows: 10,
  bulkCells: 5_000,
  rowsPage: 200,
  syncExportCells: 2_000,
} as const;

const noNul = (text: string) => !text.includes("\0");
const text = (max: number) => z.string().max(max).refine(noNul, "Text cannot hold a NUL byte");

export const ColumnType = z.enum([
  "date",
  "currency",
  "number",
  "verbatim",
  "free",
  "classify",
  "manual",
]);
export type ColumnType = z.infer<typeof ColumnType>;

/** Six flag colours; classify options may also use teal and gray. */
export const FlagColor = z.enum(["red", "orange", "yellow", "green", "blue", "purple"]);
export type FlagColor = z.infer<typeof FlagColor>;
export const OptionColor = z.enum([...FlagColor.options, "teal", "gray"]);
export type OptionColor = z.infer<typeof OptionColor>;

/** ISO 4217 shape; the parser knows which codes are real. */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);

export const ClassifyOption = z
  .object({
    id: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9_-]+$/),
    label: text(80).pipe(z.string().trim().min(1)),
    color: OptionColor,
    description: text(500).optional(),
  })
  .strict();
export type ClassifyOption = z.infer<typeof ClassifyOption>;

const uniqueOptions = (options: readonly ClassifyOption[]) =>
  new Set(options.map((o) => o.id)).size === options.length &&
  new Set(options.map((o) => o.label.toLowerCase())).size === options.length;

export const DateOptions = z.object({ allow_partial: z.boolean().default(true) }).strict();
export const CurrencyOptions = z
  .object({
    default_currency: CurrencyCode.default("USD"),
    decimals: z.number().int().min(0).max(4).default(2),
  })
  .strict();
// Without decimals, a number keeps the precision it was written with: "90 days" stays 90.
export const NumberOptions = z
  .object({
    decimals: z.number().int().min(0).max(4).optional(),
    unit: text(40).optional(),
  })
  .strict();
export const VerbatimOptions = z
  .object({ max_chars: z.number().int().min(20).max(10_000).default(2_000) })
  .strict();
export const FreeOptions = z
  .object({ max_words: z.number().int().min(1).max(2_000).default(150) })
  .strict();
export const ClassifyOptions = z
  .object({
    options: z.array(ClassifyOption).min(2).max(RT_LIMITS.classifyOptions),
    allow_multiple: z.boolean().default(false),
    allow_other: z.boolean().default(true),
  })
  .strict()
  .refine((o) => uniqueOptions(o.options), "Option ids and labels must be unique");
export const ManualOptions = z
  .object({
    input_type: z.enum(["free", "classify"]).default("free"),
    options: z.array(ClassifyOption).max(RT_LIMITS.classifyOptions).optional(),
  })
  .strict()
  .refine((o) => !o.options || uniqueOptions(o.options), "Option ids and labels must be unique");

/** The options schema for each column type, so a stored column is always re-checkable. */
export const OPTIONS_BY_TYPE = {
  date: DateOptions,
  currency: CurrencyOptions,
  number: NumberOptions,
  verbatim: VerbatimOptions,
  free: FreeOptions,
  classify: ClassifyOptions,
  manual: ManualOptions,
} as const;

export type ColumnOptionsFor<T extends ColumnType> = z.infer<(typeof OPTIONS_BY_TYPE)[T]>;
export type ColumnOptions = { [T in ColumnType]: ColumnOptionsFor<T> }[ColumnType];

/** Checks options against a type and fills defaults; the error says what's wrong. */
export function parseColumnOptions(
  type: ColumnType,
  options: unknown,
): { success: true; data: ColumnOptions } | { success: false; error: string } {
  const result = OPTIONS_BY_TYPE[type].safeParse(options ?? {});
  return result.success
    ? { success: true, data: result.data as ColumnOptions }
    : { success: false, error: result.error.issues[0]?.message ?? "Invalid options" };
}

export const Settings = z
  .object({
    default_language: z.string().min(2).max(35).default("en"),
    date_format: z.enum(["ISO", "DMY", "MDY", "long"]).default("ISO"),
    currency_display: z.enum(["symbol", "code"]).default("code"),
    number_decimals: z.number().int().min(0).max(4).default(2),
    null_display: text(20).default("—"),
    wrap_mode: z.enum(["none", "compact", "full"]).default("compact"),
  })
  .strict();
export type Settings = z.infer<typeof Settings>;
export const DEFAULT_SETTINGS: Settings = Settings.parse({});

export const CellStatus = z.enum([
  "pending",
  "queued",
  "running",
  "done",
  "null",
  "error",
  "blocked",
  "stale",
]);
export type CellStatus = z.infer<typeof CellStatus>;

/** Why a cell has no value. ACCESS_DENIED: the runner can't read a row's document. */
export const CellErrorCode = z.enum([
  "DOC_NOT_READY",
  "CONTEXT_TOO_LARGE",
  "MODEL_ERROR",
  "CITATION_UNVERIFIED",
  "PARSE_FAILED",
  "ACCESS_DENIED",
]);
export type CellErrorCode = z.infer<typeof CellErrorCode>;

export const ValueTyped = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("date"),
    iso: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/),
    precision: z.enum(["day", "month", "year"]),
  }),
  z.object({
    kind: z.literal("currency"),
    amount: z.string().regex(/^-?\d+(\.\d+)?$/),
    currency: CurrencyCode,
  }),
  z.object({
    kind: z.literal("number"),
    value: z.string().regex(/^-?\d+(\.\d+)?$/),
    unit: z.string().max(40).optional(),
  }),
  z.object({ kind: z.literal("verbatim"), text: z.string(), citation_id: Id.nullable() }),
  z.object({ kind: z.literal("free"), markdown: z.string() }),
  z.object({
    kind: z.literal("classify"),
    option_ids: z.array(z.string()),
    other: z.string().optional(),
  }),
  z.object({
    kind: z.literal("manual"),
    text: z.string().optional(),
    option_ids: z.array(z.string()).optional(),
  }),
]);
export type ValueTyped = z.infer<typeof ValueTyped>;

/** What a null cell read, so a reviewer can judge whether the search was enough. */
export const LookedAt = z.object({
  documents: z.array(z.object({ document_id: Id, pages: z.array(z.number().int().min(1)) })),
  queries: z.array(z.string()),
  chunks_read: z.number().int().min(0),
  note: z.string(),
});
export type LookedAt = z.infer<typeof LookedAt>;

const Usage = z.object({ input_tokens: z.number().int(), output_tokens: z.number().int() });

export const Cell = z.object({
  id: Id,
  row_id: Id,
  column_id: Id,
  status: CellStatus,
  error_code: CellErrorCode.nullable(),
  value_text: z.string().nullable(),
  value_typed: ValueTyped.nullable(),
  reasoning: z.string().nullable(),
  looked_at: LookedAt.nullable(),
  citation_count: z.number().int(),
  verified_citation_count: z.number().int(),
  verified_by: Id.nullable(),
  verified_at: z.string().nullable(),
  locked: z.boolean(),
  edited_by: Id.nullable(),
  flag_color: FlagColor.nullable(),
  stale_since: z.string().nullable(),
  model: z.string().nullable(),
  usage: Usage.nullable(),
  cost_usd: z.number().nullable(),
  run_id: Id.nullable(),
  updated_at: z.string(),
});
export type Cell = z.infer<typeof Cell>;

export const CellCitation = z.object({
  id: Id,
  ordinal: z.number().int().min(1),
  document_id: Id,
  version_id: Id,
  version_no: z.number().int(),
  document_name: z.string(),
  page: z.number().int().nullable(),
  quote: z.string(),
  char_from: z.number().int().nullable(),
  char_to: z.number().int().nullable(),
  status: z.enum(["ok", "mismatch", "unresolved"]),
  user_edited: z.boolean(),
  /** Only a verified citation links to the viewer. */
  open_url: z.string().nullable(),
});
export type CellCitation = z.infer<typeof CellCitation>;

export const CellHistory = z.object({
  at: z.string(),
  actor_id: Id.nullable(),
  field: z.enum(["value", "status", "verified", "locked", "flag", "run"]),
  old: z.unknown(),
  new: z.unknown(),
});
export type CellHistory = z.infer<typeof CellHistory>;

export const ColumnState = z.enum(["pending", "running", "done", "partial", "stopped"]);
export type ColumnState = z.infer<typeof ColumnState>;

export const Column = z.object({
  id: Id,
  ordinal: z.number().int(),
  label: z.string(),
  type: ColumnType,
  prompt: z.string(),
  language: z.string().nullable(),
  model: z.string().nullable(),
  context_document_id: Id.nullable(),
  options: z.record(z.string(), z.unknown()),
  state: ColumnState,
  /** Set when the last run was a dry run, so the header can offer "Run remaining". */
  dry_run: z.boolean(),
  progress: z.object({
    done: z.number().int(),
    total: z.number().int(),
    null: z.number().int(),
    error: z.number().int(),
    cost_usd: z.number(),
  }),
  run_id: Id.nullable(),
});
export type Column = z.infer<typeof Column>;

export const Row = z.object({
  id: Id,
  ordinal: z.number().int(),
  document_ids: z.array(Id),
  /** Empty names and statuses when the caller can't read a document. */
  documents: z.array(
    z.object({ id: Id, name: z.string(), status: z.string(), version_no: z.number().int() }),
  ),
  /** True when a wall or the bin hides a document: no cell values are sent for this row. */
  restricted: z.boolean(),
  flag_color: FlagColor.nullable(),
  locked: z.boolean(),
});
export type Row = z.infer<typeof Row>;

export const SourceKind = z.enum(["vault", "uploads"]);
export type SourceKind = z.infer<typeof SourceKind>;

export const TableStats = z.object({
  rows: z.number().int(),
  columns: z.number().int(),
  cells_done: z.number().int(),
  cells_null: z.number().int(),
  cells_error: z.number().int(),
  cost_usd: z.number(),
  valid_citation_rate: z.number().nullable(),
});
export type TableStats = z.infer<typeof TableStats>;

export const ReviewTable = z.object({
  id: Id,
  workspace_id: Id,
  owner_id: Id,
  name: z.string(),
  source_kind: SourceKind,
  vault_id: Id.nullable(),
  folder_ids: z.array(Id).nullable(),
  thread_id: Id.nullable(),
  matter_id: Id.nullable(),
  instructions: z.string(),
  settings: Settings,
  stats: TableStats,
  starred: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ReviewTable = z.infer<typeof ReviewTable>;

/** One table, one source: a vault (whole, folders or files), loose uploads, or a thread's files. */
export const TableSource = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("vault"),
      vault_id: Id,
      folder_ids: z.array(Id).min(1).max(100).optional(),
      document_ids: z.array(Id).min(1).max(RT_LIMITS.vaultDocuments).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("uploads"),
      upload_ids: z.array(Id).min(1).max(RT_LIMITS.uploads),
    })
    .strict(),
  z.object({ kind: z.literal("thread"), thread_id: Id }).strict(),
]);
export type TableSource = z.infer<typeof TableSource>;

export const CreateTableBody = z
  .object({
    name: text(200).pipe(z.string().trim().min(1)).optional(),
    source: TableSource,
    matter_id: Id.nullable().optional(),
  })
  .strict();
export type CreateTableBody = z.infer<typeof CreateTableBody>;

export const PatchTableBody = z
  .object({
    name: text(200).pipe(z.string().trim().min(1)).optional(),
    instructions: text(RT_LIMITS.instructionsChars).optional(),
    settings: Settings.partial().optional(),
  })
  .strict();
export type PatchTableBody = z.infer<typeof PatchTableBody>;

export const AddRowsBody = z
  .object({ document_ids: z.array(Id).min(1).max(RT_LIMITS.vaultDocuments) })
  .strict();
export type AddRowsBody = z.infer<typeof AddRowsBody>;

const columnFields = {
  label: text(RT_LIMITS.labelChars).pipe(z.string().trim().min(1)),
  prompt: text(RT_LIMITS.promptChars),
  language: z.string().min(2).max(35).optional(),
  model: z.string().min(1).max(200).nullable().optional(),
  context_document_id: Id.nullable().optional(),
  position: z.number().int().min(0).optional(),
};

/** Options are checked against the type with parseColumnOptions after this parse. */
export const CreateColumnBody = z
  .object({ ...columnFields, type: ColumnType, options: z.unknown().optional() })
  .strict()
  .superRefine((body, ctx) => {
    const parsed = parseColumnOptions(body.type, body.options);
    if (!parsed.success) ctx.addIssue({ code: "custom", path: ["options"], message: parsed.error });
    if (body.type !== "manual" && body.prompt.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["prompt"], message: "Write a prompt" });
    }
  });
export type CreateColumnBody = z.infer<typeof CreateColumnBody>;

export const PatchColumnBody = z
  .object({
    label: columnFields.label.optional(),
    prompt: columnFields.prompt.optional(),
    language: columnFields.language,
    model: columnFields.model,
    context_document_id: columnFields.context_document_id,
    type: ColumnType.optional(),
    options: z.unknown().optional(),
  })
  .strict();
export type PatchColumnBody = z.infer<typeof PatchColumnBody>;

export const ReorderColumnsBody = z
  .object({ column_ids: z.array(Id).min(1).max(RT_LIMITS.columns) })
  .strict()
  .refine((b) => new Set(b.column_ids).size === b.column_ids.length, "Ids repeat");

export const GenerateColumnsBody = z
  .object({
    description: text(2_000).pipe(z.string().trim().min(3)),
    max_columns: z.number().int().min(1).max(RT_LIMITS.proposals).default(12),
  })
  .strict();
export type GenerateColumnsBody = z.infer<typeof GenerateColumnsBody>;

/** A proposed column; only proposals that validate as a CreateColumnBody are returned. */
export const ColumnProposal = z.object({
  label: z.string(),
  type: ColumnType,
  prompt: z.string(),
  options: z.record(z.string(), z.unknown()),
});
export type ColumnProposal = z.infer<typeof ColumnProposal>;

/** all: every row; pending: rows never run or stale; dry_run: the first 10 rows. */
export const RunScope = z.union([
  z.enum(["all", "pending", "dry_run"]),
  z.object({ row_ids: z.array(Id).min(1).max(RT_LIMITS.bulkCells) }).strict(),
]);
export type RunScope = z.infer<typeof RunScope>;

export const RunTableBody = z
  .object({ scope: z.enum(["pending", "dry_run"]).default("pending") })
  .strict();
export type RunTableBody = z.infer<typeof RunTableBody>;

export const EstimateBody = z
  .object({
    column_ids: z.array(Id).min(1).max(RT_LIMITS.columns),
    scope: RunScope.default("all"),
    include_verified: z.boolean().default(false),
  })
  .strict();
export type EstimateBody = z.infer<typeof EstimateBody>;

export const Estimate = z.object({
  cells: z.number().int(),
  locked_skipped: z.number().int(),
  verified_skipped: z.number().int(),
  est_tokens: z.number().int(),
  est_cost_usd: z.number(),
  est_minutes: z.number(),
});
export type Estimate = z.infer<typeof Estimate>;

export const PatchCellBody = z
  .object({
    value_text: text(100_000).nullable().optional(),
    verified: z.boolean().optional(),
    locked: z.boolean().optional(),
    flag_color: FlagColor.nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, "Nothing to change");
export type PatchCellBody = z.infer<typeof PatchCellBody>;

export const BulkOp = z.enum(["verify", "unverify", "lock", "unlock", "flag", "unflag", "rerun"]);
export type BulkOp = z.infer<typeof BulkOp>;

export const BulkCellsBody = z
  .object({
    cell_ids: z.array(Id).min(1).max(RT_LIMITS.bulkCells),
    op: BulkOp,
    flag_color: FlagColor.optional(),
  })
  .strict()
  .refine((b) => (b.op === "flag") === (b.flag_color !== undefined), {
    message: "flag needs a flag_color, and only flag takes one",
    path: ["flag_color"],
  });
export type BulkCellsBody = z.infer<typeof BulkCellsBody>;

/** One condition on a column's cells; conditions in a filter all hold (AND). */
export const CellCondition = z
  .object({
    column_id: Id,
    status: z.array(CellStatus).min(1).optional(),
    flag: z.array(FlagColor).min(1).optional(),
    /** true: any flag; false: no flag. */
    flagged: z.boolean().optional(),
    verified: z.boolean().optional(),
    locked: z.boolean().optional(),
    /** Case-insensitive substring of value_text. */
    contains: text(200).optional(),
    /** Classify option ids, any of. */
    option_ids: z.array(z.string().max(40)).min(1).optional(),
  })
  .strict();
export type CellCondition = z.infer<typeof CellCondition>;

export const RowFilter = z
  .object({ conditions: z.array(CellCondition).max(20).default([]) })
  .strict();
export type RowFilter = z.infer<typeof RowFilter>;

export const RowSort = z.object({ column_id: Id, direction: z.enum(["asc", "desc"]) }).strict();
export type RowSort = z.infer<typeof RowSort>;

/** "column_id:asc" or "column_id:desc", as the rows query string carries it. */
export function parseSort(raw: string): RowSort | null {
  const [columnId, direction] = raw.split(":");
  const parsed = RowSort.safeParse({ column_id: columnId, direction });
  return parsed.success ? parsed.data : null;
}

/** A dry run takes the first rows in the order and filter the user is looking at. */
export const RunColumnBody = z
  .object({
    scope: RunScope.default("all"),
    include_verified: z.boolean().default(false),
    sort: RowSort.optional(),
    filter: RowFilter.optional(),
  })
  .strict();
export type RunColumnBody = z.infer<typeof RunColumnBody>;

export const ExportBody = z
  .object({
    format: z.enum(["xlsx", "csv"]),
    include_reasoning: z.boolean().default(false),
    include_citations: z.boolean().default(false),
    highlight_verified: z.boolean().default(false),
    highlight_flagged: z.boolean().default(false),
    classify_colors: z.boolean().default(false),
    only_filtered_rows: RowFilter.optional(),
    only_columns: z.array(Id).min(1).max(RT_LIMITS.columns).optional(),
  })
  .strict();
export type ExportBody = z.infer<typeof ExportBody>;

/** Lenient on value, since small models vary; the typed parser decides what it means. */
export const ModelCellOutput = z.object({
  value: z.union([z.string(), z.number(), z.array(z.string()), z.null()]).optional(),
  reasoning: z.string().max(10_000).optional().default(""),
  citations: z
    .array(
      z.object({
        doc: z.string().max(20),
        page: z.coerce.number().int().min(1).optional(),
        quote: z.string().max(4_000),
      }),
    )
    .max(20)
    .optional()
    .default([]),
  not_found: z.boolean().optional().default(false),
});
export type ModelCellOutput = z.infer<typeof ModelCellOutput>;

/** Ids, status and counts only: the log outlives walls, so values are re-read from the cell. */
export const CellUpdatedData = z.object({
  table_id: Id,
  cell_id: Id,
  row_id: Id,
  column_id: Id,
  status: CellStatus,
  error_code: CellErrorCode.nullable().optional(),
  citation_count: z.number().int(),
  verified_citation_count: z.number().int(),
  cost_usd: z.number().nullable().optional(),
});
export type CellUpdatedData = z.infer<typeof CellUpdatedData>;

export const ColumnProgressData = z.object({
  table_id: Id,
  column_id: Id,
  done: z.number().int(),
  total: z.number().int(),
  null: z.number().int(),
  error: z.number().int(),
  cost_usd: z.number(),
});
export type ColumnProgressData = z.infer<typeof ColumnProgressData>;

/** Error codes the review-table API answers with. */
export const TableErrorCode = z.enum([
  "INVALID_REQUEST",
  "NOT_FOUND",
  "FORBIDDEN",
  "SOURCE_LIMIT",
  "SOURCE_MISMATCH",
  "SOURCE_MIXED",
  "SOURCE_EMPTY",
  "COLUMN_LIMIT",
  "COLUMN_RUNNING",
  "COLUMN_MANUAL",
  "CONTEXT_FILE_SOURCE_MISMATCH",
  "CELL_LOCKED",
  "EXPORT_DISABLED_BY_SOURCE",
  "MODEL_NOT_ALLOWED",
  "MODEL_UNAVAILABLE",
  "EXPORT_TOO_LARGE",
]);
export type TableErrorCode = z.infer<typeof TableErrorCode>;
