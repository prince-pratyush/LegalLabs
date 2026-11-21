import type { FileRef, RoutingClass, SourceRef, WorkflowDefinition } from "@legallabs/contracts";
import type { RunRow } from "@legallabs/runs";

// Every side effect of a workflow run goes through one of these, so tests script them and the
// API connects the real modules. Each is called as the run's owner: a port must apply that
// person's row-level security, and must treat `idempotency_key` as "same call, same result".

/** A document a step reads, pinned to the version current when the step started. */
export interface ResolvedFile {
  document_id: string;
  version_id: string;
  name: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens?: number;
}

/** What a call that may spend money reports, so the step and the run carry the cost. */
export interface Spend {
  /** "provider/model". */
  model: string;
  usage: Usage;
  cost_usd: number;
}

/** A form answer: files for a file input, text, option ids, or a review table id. */
export type InputValue = FileRef[] | string | string[];
export type RunInputs = Record<string, InputValue>;

export interface LoadedWorkflow {
  definition: WorkflowDefinition;
  /** Keyed by input label; matched without regard to case. */
  inputs: RunInputs;
  title: string;
}

/** The pinned version's definition and what the person filled in. */
export interface WorkflowSource {
  load(run: RunRow): Promise<LoadedWorkflow | null>;
}

/** The workspace allow-list, the matter's restrictions, region and retention rules. */
export interface ModelPolicy {
  /** Models this run may use for a class; empty means the class can't run at all. */
  eligible(run: RunRow, routingClass: RoutingClass): Promise<readonly string[]>;
  /** Whether a block's explicitly chosen model ("provider/model") is allowed for this run. */
  permits(run: RunRow, model: string): Promise<boolean>;
}

export interface Citations {
  total: number;
  verified: number;
  mismatch: number;
  unresolved: number;
}

export interface ModelRequest {
  routing_class: RoutingClass;
  /** Set only when the block named a model and the policy permits it. */
  model?: string;
  prompt: string;
  documents: ResolvedFile[];
  /** Review tables attached as context. */
  tables: string[];
  sources: SourceRef[];
  output: "text" | "markdown" | "json";
  json_schema?: Record<string, unknown>;
  deep_analysis: boolean;
  idempotency_key: string;
}

export interface ModelPort {
  complete(
    run: RunRow,
    request: ModelRequest,
  ): Promise<Spend & { text: string; citations?: Citations }>;
}

/** Resolves embedded files, vaults, folders and form uploads. Walled ones resolve to none. */
export interface FilePort {
  resolve(run: RunRow, ref: FileRef): Promise<ResolvedFile[]>;
}

export interface DraftRequest {
  title: string;
  format: "docx" | "pptx" | "xlsx";
  mode: "from_scratch" | "edit_file";
  base?: ResolvedFile;
  template?: ResolvedFile;
  instructions: string;
  documents: ResolvedFile[];
  tables: string[];
  track_changes: boolean;
  idempotency_key: string;
}

/** The drafting agent: makes a document owned by the runner and attached to the run's thread. */
export interface DraftPort {
  draft(run: RunRow, request: DraftRequest): Promise<Spend & { file: ResolvedFile }>;
}

export interface TableColumn {
  label: string;
  type: string;
  prompt: string;
  options?: string[];
  depends_on?: string[];
}

export interface TableRows {
  rows_done: number;
  rows_total: number;
}

export interface TableSnapshot {
  table_id: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

/** Review tables: owned by the runner, attached to the thread, cells run as child runs. */
export interface TablePort {
  /** Makes the table and runs `limit_rows` rows (all when left out), waiting for them. */
  generate(
    run: RunRow,
    request: {
      title: string;
      documents: ResolvedFile[];
      columns: TableColumn[];
      instructions?: string;
      limit_rows?: number;
      idempotency_key: string;
    },
  ): Promise<Spend & TableRows & { table_id: string }>;
  /** Runs the rows a dry run left. */
  complete(
    run: RunRow,
    request: { table_id: string; idempotency_key: string },
  ): Promise<Spend & TableRows>;
  /** A snapshot of a table the runner can read; null when it can't. No model call. */
  select(
    run: RunRow,
    request: { table_id: string; columns?: string[]; row_filter?: Record<string, unknown> },
  ): Promise<TableSnapshot | null>;
}

/** Posts the Response block's outputs to the run's thread. */
export interface ArtifactPort {
  message(
    run: RunRow,
    request: { title?: string; text: string; idempotency_key: string },
  ): Promise<{ message_id: string }>;
  file(
    run: RunRow,
    request: { title?: string; file: ResolvedFile; idempotency_key: string },
  ): Promise<{ message_id: string; artifact_id: string }>;
  table(
    run: RunRow,
    request: { title?: string; table_id: string; idempotency_key: string },
  ): Promise<{ message_id: string; artifact_id: string }>;
}

export interface WorkflowPorts {
  source: WorkflowSource;
  model: ModelPort;
  policy: ModelPolicy;
  files: FilePort;
  drafts: DraftPort;
  tables: TablePort;
  artifacts: ArtifactPort;
}

/** A port's refusal that retrying won't change; the step and run fail with this code. */
export class WorkflowStepError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowStepError";
  }
}
