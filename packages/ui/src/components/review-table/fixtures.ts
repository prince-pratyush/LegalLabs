import type { GridCell, GridColumn, GridRow } from "./types.js";

// Sample data for stories and tests; names are invented.
export const sampleCell = (patch: Partial<GridCell> = {}): GridCell => ({
  id: "c1",
  row_id: "r1",
  column_id: "k1",
  status: "done",
  error_code: null,
  value_text: "Delaware",
  citation_count: 2,
  verified_at: null,
  locked: false,
  edited_by: null,
  flag_color: null,
  updated_at: "2026-11-15T10:00:18Z",
  ...patch,
});

export const sampleColumn = (patch: Partial<GridColumn> = {}): GridColumn => ({
  id: "k1",
  label: "Governing law",
  type: "free",
  prompt: "Which law governs the agreement?",
  state: "done",
  dry_run: false,
  progress: { done: 3, total: 3, null: 0, error: 0, cost_usd: 0 },
  ...patch,
});

const NAMES = ["MSA_Acme.pdf", "NDA_Beta.docx", "SPA_Gamma.pdf", "Lease_Delta.pdf"];

export const sampleRows = (count: number): GridRow[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `r${i + 1}`,
    documents: [{ id: `d${i + 1}`, name: `${i + 1}-${NAMES[i % NAMES.length]}` }],
    restricted: false,
  }));

export const sampleColumns: GridColumn[] = [
  sampleColumn(),
  sampleColumn({ id: "k2", label: "Change of control", type: "classify", state: "running" }),
  sampleColumn({ id: "k3", label: "Termination fee", type: "currency" }),
  sampleColumn({ id: "k4", label: "Notes", type: "manual", state: "pending" }),
];

const VALUES: Record<string, string> = {
  k1: "Delaware",
  k2: "Yes · §12.3",
  k3: "USD 250,000.00",
  k4: "",
};

/** A spread of states across a sample grid, keyed by row and column. */
export function sampleCellFor(rowId: string, columnId: string): GridCell | undefined {
  const n = Number(rowId.slice(1));
  if (columnId === "k4") return undefined;
  const base = sampleCell({
    id: `${rowId}-${columnId}`,
    row_id: rowId,
    column_id: columnId,
    value_text: VALUES[columnId] ?? null,
  });
  if (columnId === "k2" && n % 5 === 2) return { ...base, status: "running", value_text: null };
  if (columnId === "k3" && n % 7 === 3)
    return { ...base, status: "error", error_code: "MODEL_ERROR" };
  if (columnId === "k3" && n % 7 === 2) return { ...base, status: "null", value_text: null };
  if (n % 4 === 1) return { ...base, verified_at: "2026-11-15T09:00:00Z" };
  if (n % 6 === 0) return { ...base, flag_color: "red", locked: true };
  return base;
}
