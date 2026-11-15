import type {
  Customisation,
  Finding,
  Gap,
  ReviewEvent,
  ReviewSummary,
  Rule,
} from "@legallabs/contracts";

export type ReviewParagraph = {
  index: number;
  text: string;
  section_path?: string;
  /** Header, footnote body, field etc.: read for context, never mapped or edited. */
  excluded?: boolean;
  para_hash: string;
};

export type ExistingEdit = {
  paragraph_index: number;
  kind: "ins" | "del";
  text: string;
  author?: string;
};

export type ReviewInput = {
  paragraphs: ReviewParagraph[];
  existingEdits: ExistingEdit[];
  rules: Rule[];
  guidance?: string;
  customisation: Customisation;
  extraContext?: string;
  signal?: AbortSignal;
};

export type Task = "extract" | "draft" | "verify";

export type CompleteCall = {
  task: Task;
  system: string;
  prompt: string;
  json: true;
  maxTokens: number;
  signal?: AbortSignal;
};

export type CompleteResult = {
  text: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  cost_usd: number;
};

export type ReviewDeps = {
  complete: (call: CompleteCall) => Promise<CompleteResult>;
  onEvent?: (e: ReviewEvent) => void;
  /** uuid v7 */
  newId?: () => string;
  now?: () => Date;
  /** Concurrent model calls; capped at 8. */
  concurrency?: number;
  /** Per-rule budget; 60 s unless a test shortens it. */
  ruleTimeoutMs?: number;
};

export type ReviewUsage = {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  models: string[];
};

export type ReviewOutcome = {
  clause_map: Record<string, number[]>;
  uncovered: number[];
  results: Finding[];
  gaps: Gap[];
  summary: ReviewSummary;
  usage: ReviewUsage;
  coverage: { paragraphs: number; read: number };
  warnings: ("over_100_pages" | "existing_tracked_changes" | "partial_coverage")[];
  /** True when the signal fired; results hold only rules that finished. */
  aborted: boolean;
};
