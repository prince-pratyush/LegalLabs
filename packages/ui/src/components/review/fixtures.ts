import type { Finding, Gap, Review, Suggestion } from "@legallabs/contracts";
import type { ReviewParagraph } from "./review-document.js";
import type { GridCell, GridColumn, GridRow } from "./types.js";

// Story and test data only; every party, clause and figure here is invented.
const id = (n: number) => `0190b000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const HASH = "a".repeat(64);

export const sampleParagraphs: ReviewParagraph[] = [
  { index: 0, text: "Services Agreement", excluded: false },
  {
    index: 1,
    section_path: "1",
    text: '1. Definitions. "Confidential Information" means any information disclosed by either party.',
    excluded: false,
  },
  {
    index: 2,
    section_path: "2",
    text: "2. Confidentiality. The Recipient shall keep Confidential Information secret for one year after disclosure.",
    excluded: false,
  },
  {
    index: 3,
    section_path: "3",
    text: "3. Liability. The Supplier's total liability under this Agreement is capped at the fees paid in the 3 months before the claim.",
    excluded: false,
  },
  {
    index: 4,
    section_path: "4",
    text: "4. Payment. The Customer shall pay each invoice within 30 days of receipt.",
    excluded: false,
  },
  {
    index: 5,
    section_path: "5",
    text: "5. Assignment. The Supplier may assign this Agreement to any affiliate without notice.",
    excluded: false,
  },
  { index: 6, text: "Page 1 of 1", excluded: true },
];

const usage = { input_tokens: 1200, output_tokens: 300 };
const base = {
  flag: false,
  verification: "ok" as const,
  model: "anthropic/claude-haiku-5-5",
  usage,
  cost_usd: 0.0003,
};

export const liabilitySuggestion: Suggestion = {
  id: id(901),
  rule_id: id(11),
  anchor: { paragraph_index: 3, char_from: 69, char_to: 125, para_hash: HASH },
  kind: "replace",
  before: "capped at the fees paid in the 3 months before the claim",
  after: "capped at the fees paid in the 24 months before the claim",
  justification:
    "Our standard position is a cap of 24 months' fees; three months leaves the Customer without a meaningful remedy.",
  status: "pending",
};

export const sampleFindings: Finding[] = [
  {
    ...base,
    rule_id: id(11),
    rule_title: "Limitation of liability",
    status: "not_acceptable",
    flag: true,
    evidence: [
      {
        paragraph_index: 3,
        section_path: "3",
        char_from: 69,
        char_to: 125,
        quote: "capped at the fees paid in the 3 months before the claim",
        verified: "ok",
      },
    ],
    matched: "unacceptable",
    explanation: "The cap is three months' fees; anything under twelve months is unacceptable.",
    suggestion: liabilitySuggestion,
  },
  {
    ...base,
    rule_id: id(12),
    rule_title: "Confidentiality term",
    status: "needs_review",
    evidence: [
      {
        paragraph_index: 2,
        section_path: "2",
        char_from: 20,
        char_to: 106,
        quote:
          "The Recipient shall keep Confidential Information secret for one year after disclosure",
        verified: "ok",
      },
    ],
    matched: "none",
    explanation:
      "One year is shorter than the three-year standard; check whether trade secrets are carved out.",
    suggestion: {
      id: id(902),
      rule_id: id(12),
      anchor: { paragraph_index: 2, char_from: 81, char_to: 89, para_hash: HASH },
      kind: "replace",
      before: "one year",
      after: "three years",
      justification: "The playbook asks for at least three years.",
      status: "applied",
      applied_with_comment: true,
      decided_at: "2026-11-15T10:00:00.000Z",
    },
  },
  {
    ...base,
    rule_id: id(13),
    rule_title: "Payment terms",
    status: "acceptable",
    evidence: [
      {
        paragraph_index: 4,
        section_path: "4",
        char_from: 12,
        char_to: 73,
        quote: "The Customer shall pay each invoice within 30 days of receipt",
        verified: "ok",
      },
    ],
    matched: "standard",
    explanation: "Thirty days matches the standard position.",
  },
  {
    ...base,
    rule_id: id(14),
    rule_title: "Governing law",
    status: "not_found",
    evidence: [],
    matched: "none",
    explanation: "No paragraph in the document deals with this rule.",
    suggestion: {
      id: id(903),
      rule_id: id(14),
      anchor: { paragraph_index: 5, char_from: 0, char_to: 86, para_hash: HASH },
      kind: "insert_after",
      before: "",
      after: "6. Governing law. This Agreement is governed by the laws of England and Wales.",
      justification: "The Governing law clause is missing; this adds the playbook's model clause.",
      status: "dismissed",
    },
  },
  {
    ...base,
    rule_id: id(15),
    rule_title: "Data protection",
    status: "skipped",
    evidence: [],
    explanation: "Skipped: only when the paper is ours.",
  },
];

export const sampleGaps: Gap[] = [
  {
    id: id(21),
    kind: "uncovered_clause",
    severity: "high",
    reason: "The Supplier can assign to an affiliate without notice; no rule covers assignment.",
    evidence: [
      {
        paragraph_index: 5,
        section_path: "5",
        char_from: 15,
        char_to: 85,
        quote: "The Supplier may assign this Agreement to any affiliate without notice",
        verified: "ok",
      },
    ],
    suggestion: {
      id: id(904),
      rule_id: null,
      gap_id: id(21),
      anchor: { paragraph_index: 5, char_from: 71, char_to: 85, para_hash: HASH },
      kind: "replace",
      before: "without notice",
      after: "with 30 days' written notice to the Customer",
      justification: "Notice lets the Customer object to an assignee it cannot work with.",
      status: "pending",
    },
  },
];

export const sampleReview: Review = {
  id: id(1),
  run_id: id(2),
  playbook_id: id(3),
  playbook_version_id: id(4),
  playbook_name: "Customer services agreement",
  document_id: id(5),
  document_version_id: id(6),
  document_name: "Supplier services agreement.docx",
  customisation: {
    party: "Northwind Ltd (Customer)",
    paper: "theirs",
    mode: "standard",
    scope: "all",
  },
  surface: "web",
  status: "done",
  clause_map_size: 4,
  excluded_regions: { footer: 1 },
  results: sampleFindings,
  gaps: sampleGaps,
  summary: { acceptable: 1, needs_review: 1, not_acceptable: 1, not_found: 1, gaps: 1 },
  warnings: [],
  usage: { input_tokens: 9000, output_tokens: 2100, cost_usd: 0.0021, models: [base.model] },
  started_at: "2026-11-15T09:58:00.000Z",
  finished_at: "2026-11-15T10:00:30.000Z",
};

export const sampleRuleChoices = sampleFindings.map((f) => ({
  id: f.rule_id,
  title: f.rule_title,
}));

// Review-table grid samples.

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
