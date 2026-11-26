export const SURFACE_LABEL: Record<string, string> = {
  web: "Web",
  word: "Word add-in",
  outlook: "Outlook add-in",
  review_tables: "Review tables",
  agents: "Agents",
  apps: "Apps",
  email: "Email",
  api: "API",
  mobile: "Mobile",
};

export const WORKFLOW_LABEL: Record<string, string> = {
  contract_reviewed: "Contract reviewed",
  redline_applied: "Redline applied",
  table_exported: "Review table exported",
  draft_exported: "Draft exported",
  research_memo_completed: "Research memo completed",
  request_resolved: "Request resolved",
  chronology_generated: "Chronology generated",
  translation_completed: "Translation completed",
  proofread_applied: "Proofread applied",
};

// Nothing in this build writes these, so a zero would read as "nobody used it". Take one off
// the list when the feature starts recording (the callers of command-center/record.ts).
export const UNRECORDED_SURFACES = new Set(["outlook", "apps", "email", "api", "mobile"]);
export const UNRECORDED_WORKFLOWS = new Set([
  "request_resolved",
  "chronology_generated",
  "proofread_applied",
]);

export const NOT_RECORDED = "Not recorded";

const dayMs = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const lastDays = (days: number, now = Date.now()) => ({
  from: isoDay(now - (days - 1) * dayMs),
  to: isoDay(now),
});
