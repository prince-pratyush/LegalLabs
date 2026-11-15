// Shapes the review-table components read. They are structural subsets of the
// contracts in @legallabs/contracts, so the web app passes API objects straight in.

export const FLAG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple"] as const;
export type FlagColor = (typeof FLAG_COLORS)[number];

export const CELL_STATUSES = [
  "pending",
  "queued",
  "running",
  "done",
  "null",
  "error",
  "blocked",
  "stale",
] as const;
export type CellStatus = (typeof CELL_STATUSES)[number];

export type ColumnType =
  | "date"
  | "currency"
  | "number"
  | "verbatim"
  | "free"
  | "classify"
  | "manual";

export interface GridCell {
  id: string;
  row_id: string;
  column_id: string;
  status: CellStatus;
  error_code: string | null;
  value_text: string | null;
  citation_count: number;
  verified_at: string | null;
  locked: boolean;
  edited_by: string | null;
  flag_color: FlagColor | null;
  updated_at: string;
}

export interface ColumnProgress {
  done: number;
  total: number;
  null: number;
  error: number;
  cost_usd: number;
}

export interface GridColumn {
  id: string;
  label: string;
  type: ColumnType;
  prompt: string;
  state: "pending" | "running" | "done" | "partial" | "stopped";
  dry_run: boolean;
  progress: ColumnProgress;
}

export interface GridRow {
  id: string;
  documents: { id: string; name: string }[];
  restricted: boolean;
}

/** One key per cell, so a selection survives paging and sorting. */
export const cellKey = (rowId: string, columnId: string) => `${rowId}:${columnId}`;

export const FLAG_CLASS: Record<FlagColor, { text: string; border: string; bg: string }> = {
  red: { text: "text-flag-red", border: "border-l-flag-red", bg: "bg-flag-red" },
  orange: { text: "text-flag-orange", border: "border-l-flag-orange", bg: "bg-flag-orange" },
  yellow: { text: "text-flag-yellow", border: "border-l-flag-yellow", bg: "bg-flag-yellow" },
  green: { text: "text-flag-green", border: "border-l-flag-green", bg: "bg-flag-green" },
  blue: { text: "text-flag-blue", border: "border-l-flag-blue", bg: "bg-flag-blue" },
  purple: { text: "text-flag-purple", border: "border-l-flag-purple", bg: "bg-flag-purple" },
};

export const flagName = (color: FlagColor) => color[0]?.toUpperCase() + color.slice(1);

/** Error codes in words a reviewer can act on. */
export const ERROR_TEXT: Record<string, string> = {
  DOC_NOT_READY: "The document is still being read. Retry when it's ready.",
  CONTEXT_TOO_LARGE: "The document is too long to read in one go.",
  MODEL_ERROR: "The model didn't answer. Retry.",
  CITATION_UNVERIFIED: "None of the quotes matched the document, so the answer was dropped.",
  PARSE_FAILED: "The answer didn't fit the column type.",
  ACCESS_DENIED: "You can't read this row's document.",
};

export const errorText = (code: string | null) =>
  (code && ERROR_TEXT[code]) || "Something went wrong. Retry.";

export function formatUsd(value: number) {
  return value === 0 ? "$0" : value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
}
