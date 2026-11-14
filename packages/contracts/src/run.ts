import { z } from "zod";
import { ResponseMode } from "./thread.js";

export const RunStatus = z.enum([
  "planned",
  "awaiting_approval",
  "running",
  "awaiting_input",
  "verifying",
  "done",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunKind = z.enum(["thread", "deep_analysis"]);
export type RunKind = z.infer<typeof RunKind>;

export const CitationVerdict = z.enum(["ok", "mismatch", "unresolved"]);
export type CitationVerdict = z.infer<typeof CitationVerdict>;

const Usage = z.object({ input_tokens: z.number().int(), output_tokens: z.number().int() });

export const Coverage = z.object({
  docs_in_scope: z.number().int(),
  docs_read: z.number().int(),
  pages_in_scope: z.number().int(),
  pages_read: z.number().int(),
  mode: z.enum(["full_read", "retrieval", "deep_analysis"]),
});
export type Coverage = z.infer<typeof Coverage>;

const PlanStep = z.object({
  id: z.string(),
  title: z.string(),
  sources: z.array(z.string()),
  estimate: z.object({ docs: z.number().int(), pages: z.number().int() }),
});

export const Plan = z.object({
  steps: z.array(PlanStep),
  estimated_cost_usd: z.object({ low: z.number(), high: z.number() }),
  editable: z.boolean(),
});
export type Plan = z.infer<typeof Plan>;

export const CitationEvent = z.object({
  message_id: z.string(),
  ordinal: z.number().int().min(1),
  kind: z.enum(["document", "authority"]),
  verified: CitationVerdict,
  document: z
    .object({
      document_id: z.string(),
      version_id: z.string(),
      name: z.string(),
      page_no: z.number().int().optional(),
      char_from: z.number().int().optional(),
      char_to: z.number().int().optional(),
    })
    .optional(),
  authority: z
    .object({
      authority_id: z.string(),
      citation_string: z.string(),
      title: z.string(),
      url: z.string(),
      pin: z.string().optional(),
    })
    .optional(),
  quote: z.string(),
  // Only set when verified ok: a flagged citation is never a link.
  open_url: z.string().optional(),
});
export type CitationEvent = z.infer<typeof CitationEvent>;

export const CitationCounts = z.object({
  total: z.number().int(),
  ok: z.number().int(),
  mismatch: z.number().int(),
  unresolved: z.number().int(),
  ungrounded_sentences: z.number().int(),
});
export type CitationCounts = z.infer<typeof CitationCounts>;

const event = <T extends string, S extends z.ZodRawShape>(type: T, data: S) =>
  z.object({ type: z.literal(type), seq: z.number().int().min(1), ...data });

/** Everything a run tells the browser, in order. `seq` doubles as the SSE id. */
export const RunEvent = z.discriminatedUnion("type", [
  event("status", { status: RunStatus }),
  event("plan", { plan: Plan }),
  // Citation anchors arrive inline as [[c:N]], replaced when citation N arrives.
  event("token", { message_id: z.string(), delta: z.string() }),
  event("citation", { citation: CitationEvent }),
  event("step", {
    step_id: z.string(),
    kind: z.enum(["plan", "retrieve", "read", "generate", "verify", "report"]),
    status: z.enum(["started", "finished", "failed"]),
    title: z.string(),
    model: z.string().optional(),
    usage: Usage.optional(),
    cost_usd: z.number().optional(),
  }),
  event("coverage", { coverage: Coverage }),
  event("followups", { message_id: z.string(), items: z.array(z.string()).max(4) }),
  event("done", {
    message_id: z.string(),
    model: z.string().nullable(),
    response_mode: ResponseMode,
    usage: Usage,
    cost_usd: z.number(),
    citations: CitationCounts,
    // The sentences with no verified source, so the live view flags them too.
    ungrounded: z.array(z.tuple([z.number().int(), z.number().int()])).optional(),
    coverage: Coverage.optional(),
    duration_ms: z.number().int(),
  }),
  event("error", { code: z.string(), message: z.string(), retryable: z.boolean() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventType = RunEvent["type"];

export const FINISHED: readonly RunStatus[] = ["done", "failed", "cancelled"];

/** Events that end a run's stream. */
export const isTerminal = (event: RunEvent) =>
  event.type === "done" ||
  (event.type === "error" && !event.retryable) ||
  (event.type === "status" && FINISHED.includes(event.status));
