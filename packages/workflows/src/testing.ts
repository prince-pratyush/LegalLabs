// Scripted ports and an in-memory run store: workflow runs end to end with no model, no
// network and no database. The API's tests use the scripted ports against Postgres.
import { randomUUID } from "node:crypto";
import type { RoutingClass, WorkflowDefinition } from "@legallabs/contracts";
import {
  type ActivityDeps,
  createLocalEngine,
  type LifecycleResult,
  type RunRow,
  type RunStore,
  type StepRecord,
} from "@legallabs/runs";
import { createWorkflowHandler, type WorkflowHandlerDeps } from "./handler.js";
import { sampleFile, stableId } from "./ids.js";
import type {
  ArtifactPort,
  DraftPort,
  FilePort,
  ModelPolicy,
  ModelPort,
  ModelRequest,
  ResolvedFile,
  RunInputs,
  TablePort,
  TableSnapshot,
} from "./ports.js";

const uuidOf = stableId;

/** A file id for a test, stable for a name. */
export const testFile = sampleFile;

export interface MemoryRun {
  run: RunRow;
  steps: Map<number, StepRecord & Record<string, unknown>>;
  events: { type: string; data: Record<string, unknown> }[];
  store: RunStore;
}

export function memoryRun(over: Partial<RunRow> = {}): MemoryRun {
  const run: RunRow = {
    id: randomUUID(),
    workspace_id: randomUUID(),
    owner_id: randomUUID(),
    thread_id: randomUUID(),
    kind: "workflow",
    subject_id: randomUUID(),
    agent_version_id: null,
    workflow_version_id: randomUUID(),
    task_id: null,
    space_id: null,
    matter_id: null,
    test_mode: false,
    interactive: true,
    status: "planned",
    plan: null,
    cost_usd: 0,
    path: "page",
    ...over,
  };
  const steps = new Map<number, StepRecord & Record<string, unknown>>();
  const events: MemoryRun["events"] = [];
  const copy = (s: StepRecord | undefined) =>
    s ? (JSON.parse(JSON.stringify(s)) as StepRecord) : null;
  const store: RunStore = {
    run: async () => ({ ...run }),
    setStatus: async (status) => {
      run.status = status;
    },
    setPaused: async () => {},
    setPlan: async (plan) => {
      run.plan = plan;
    },
    event: async (type, data) => {
      events.push({ type, data });
      return events.length;
    },
    step: async (ordinal) => copy(steps.get(ordinal)),
    stepById: async (id) => copy([...steps.values()].find((s) => s.id === id)),
    beginStep: async (start) => {
      const had = steps.get(start.ordinal);
      if (had) return { step: copy(had) as StepRecord, created: false };
      const step = {
        id: randomUUID(),
        ordinal: start.ordinal,
        kind: start.kind,
        status: "running",
        block_id: start.block_id ?? null,
        label: start.label ?? null,
        input: start.input ?? {},
        output: {},
        cost_usd: 0,
      };
      steps.set(start.ordinal, step);
      return { step: copy(step) as StepRecord, created: true };
    },
    finishStep: async (ordinal, r) => {
      const s = steps.get(ordinal);
      if (!s) return;
      s.status = r.status;
      if (r.model) s.model = r.model;
      if (r.routing_class) s.routing_class = r.routing_class;
      if (r.usage) s.usage = r.usage;
      if (r.cost_usd !== undefined) s.cost_usd = r.cost_usd;
      if (r.error) s.error = r.error;
      s.output = { ...s.output, ...JSON.parse(JSON.stringify(r.output ?? {})) };
      // As the database does: the run's cost is the sum of its steps.
      run.cost_usd = [...steps.values()].reduce((sum, x) => sum + x.cost_usd, 0);
    },
    mergeOutput: async (ordinal, extra) => {
      const s = steps.get(ordinal);
      if (s) s.output = { ...s.output, ...JSON.parse(JSON.stringify(extra)) };
    },
    totals: async () => ({
      steps: steps.size,
      tokens: 0,
      cost_usd: [...steps.values()].reduce((sum, x) => sum + x.cost_usd, 0),
    }),
  };
  return { run, steps, events, store };
}

/** Every model call, so tests can count them; the same key returns the first answer. */
export function scriptedModel(
  answer: (req: ModelRequest) => string = (req) =>
    `${req.routing_class} answer to: ${req.prompt.slice(0, 200)}`,
  opts: { delayMs?: number; costUsd?: number } = {},
) {
  const calls: ModelRequest[] = [];
  const byKey = new Map<string, Awaited<ReturnType<ModelPort["complete"]>>>();
  let inFlight = 0;
  let maxInFlight = 0;
  const port: ModelPort = {
    async complete(_run, req) {
      calls.push(req);
      const seen = byKey.get(req.idempotency_key);
      if (seen) return seen;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      inFlight -= 1;
      const result = {
        model: req.model ?? `scripted/${req.routing_class}`,
        usage: { input_tokens: 100, output_tokens: 20 },
        cost_usd: opts.costUsd ?? 0.0012,
        text: answer(req),
      };
      byKey.set(req.idempotency_key, result);
      return result;
    },
  };
  return { port, calls, maxInFlight: () => maxInFlight };
}

export function allowAll(
  opts: { blockedModels?: string[]; noClasses?: RoutingClass[] } = {},
): ModelPolicy {
  return {
    eligible: async (_run, cls) => (opts.noClasses?.includes(cls) ? [] : [`scripted/${cls}`]),
    permits: async (_run, model) => !(opts.blockedModels ?? []).includes(model),
  };
}

/** Files by FileRef id; a vault ref resolves to every file registered under it. */
export function fileRegistry(names: string[] = [], vaults: Record<string, string[]> = {}) {
  const files = new Map<string, ResolvedFile>();
  const register = (name: string) => {
    const ref = testFile(name).ref;
    const file = { document_id: ref, version_id: uuidOf(`version:${name}`), name };
    files.set(ref, file);
    return file;
  };
  for (const n of names) register(n);
  const port: FilePort = {
    async resolve(_run, ref) {
      if (ref.kind === "vault" || ref.kind === "vault_folder") {
        return (vaults[ref.ref] ?? []).map(register);
      }
      const f = files.get(ref.ref);
      return f ? [f] : [];
    },
  };
  return { port, register };
}

export function scriptedDrafts() {
  const calls: Parameters<DraftPort["draft"]>[1][] = [];
  const port: DraftPort = {
    async draft(_run, req) {
      calls.push(req);
      const name = `${req.title}.${req.format}`;
      return {
        model: "scripted/draft",
        usage: { input_tokens: 300, output_tokens: 200 },
        cost_usd: 0.004,
        file: {
          document_id: uuidOf(`draft:${req.idempotency_key}`),
          version_id: uuidOf(`draftv:${req.idempotency_key}`),
          name,
        },
      };
    },
  };
  return { port, calls };
}

/** One row per document; each row costs the same, so dry runs and full runs add up. */
export function scriptedTables(rowCost = 0.0005) {
  const tables = new Map<
    string,
    { title: string; columns: string[]; rows: number; done: number }
  >();
  const calls: string[] = [];
  const port: TablePort = {
    async generate(_run, req) {
      calls.push(`generate:${req.limit_rows ?? "all"}`);
      const table_id = uuidOf(`table:${req.idempotency_key}`);
      const rows = req.documents.length;
      const done = Math.min(rows, req.limit_rows ?? rows);
      tables.set(table_id, {
        title: req.title,
        columns: req.columns.map((c) => c.label),
        rows,
        done,
      });
      return {
        table_id,
        rows_done: done,
        rows_total: rows,
        model: "scripted/extract",
        usage: { input_tokens: 50 * done, output_tokens: 10 * done },
        cost_usd: rowCost * done * req.columns.length,
      };
    },
    async complete(_run, req) {
      calls.push("complete");
      const t = tables.get(req.table_id);
      const left = t ? t.rows - t.done : 0;
      if (t) t.done = t.rows;
      return {
        rows_done: t?.rows ?? 0,
        rows_total: t?.rows ?? 0,
        model: "scripted/extract",
        usage: { input_tokens: 50 * left, output_tokens: 10 * left },
        cost_usd: rowCost * left * (t?.columns.length ?? 0),
      };
    },
    async select(_run, req): Promise<TableSnapshot | null> {
      const t = tables.get(req.table_id);
      const columns = req.columns ?? t?.columns ?? ["Name"];
      const rows = Array.from({ length: t?.done ?? 2 }, (_, i) =>
        Object.fromEntries(columns.map((c) => [c, `${c} ${i + 1}`])),
      );
      return { table_id: req.table_id, columns, rows };
    },
  };
  return { port, calls, tables };
}

export interface Posted {
  kind: "message" | "file" | "table";
  title?: string;
  text?: string;
  id: string;
}

export function capturedArtifacts() {
  const posted: Posted[] = [];
  const byKey = new Map<string, { message_id: string; artifact_id: string }>();
  const post = (kind: Posted["kind"], key: string, extra: Omit<Posted, "kind" | "id">) => {
    const seen = byKey.get(key);
    if (seen) return seen;
    const ids = { message_id: uuidOf(`m:${key}`), artifact_id: uuidOf(`a:${key}`) };
    byKey.set(key, ids);
    posted.push({ kind, id: ids.artifact_id, ...extra });
    return ids;
  };
  const port: ArtifactPort = {
    message: async (_run, r) =>
      post("message", r.idempotency_key, { text: r.text, ...(r.title ? { title: r.title } : {}) }),
    file: async (_run, r) =>
      post("file", r.idempotency_key, {
        text: r.file.name,
        ...(r.title ? { title: r.title } : {}),
      }),
    table: async (_run, r) => post("table", r.idempotency_key, r.title ? { title: r.title } : {}),
  };
  return { port, posted };
}

/** All scripted ports, with the parts a test may want to look at. */
export function scriptedPorts(
  workflow: { definition: WorkflowDefinition; inputs: RunInputs },
  opts: {
    files?: string[];
    vaults?: Record<string, string[]>;
    model?: ReturnType<typeof scriptedModel>;
    policy?: ModelPolicy;
  } = {},
) {
  const model = opts.model ?? scriptedModel();
  const files = fileRegistry(opts.files ?? [], opts.vaults ?? {});
  const drafts = scriptedDrafts();
  const tables = scriptedTables();
  const artifacts = capturedArtifacts();
  const deps: WorkflowHandlerDeps = {
    source: { load: async () => ({ ...workflow, title: "Test workflow" }) },
    model: model.port,
    policy: opts.policy ?? allowAll(),
    files: files.port,
    drafts: drafts.port,
    tables: tables.port,
    artifacts: artifacts.port,
  };
  return { deps, model, files, drafts, tables, artifacts };
}

/**
 * Runs a workflow on the real lifecycle and local engine over an in-memory store. Signals
 * given are sent once the run is waiting on a person.
 */
export async function runInMemory(
  deps: WorkflowHandlerDeps,
  opts: {
    interactive?: boolean;
    onWait?: (
      status: string,
      run: MemoryRun,
    ) => Parameters<ReturnType<typeof createLocalEngine>["signal"]>[1] | null;
  } = {},
): Promise<MemoryRun & { result: LifecycleResult }> {
  const mem = memoryRun({ interactive: opts.interactive ?? true });
  const activityDeps: ActivityDeps = {
    pool: {} as ActivityDeps["pool"],
    handlers: { workflow: createWorkflowHandler(deps) },
    storeFor: () => mem.store,
  };
  const engine = createLocalEngine(activityDeps);
  await engine.start({
    runId: mem.run.id,
    workspaceId: mem.run.workspace_id,
    userId: mem.run.owner_id,
    kind: "workflow",
    interactive: mem.run.interactive,
    budget: { max_cost_usd: null, max_tokens: 5_000_000 },
  });
  let sent = 0;
  const done = engine.result(mem.run.id);
  for (;;) {
    const winner = await Promise.race([
      done.then(() => "done" as const),
      new Promise<"tick">((r) => setTimeout(() => r("tick"), 5)),
    ]);
    if (winner === "done") break;
    if (["awaiting_approval", "awaiting_input"].includes(mem.run.status) && opts.onWait) {
      const signal = opts.onWait(mem.run.status, mem);
      if (signal && sent < 20) {
        sent += 1;
        const before = mem.events.length;
        await engine.signal(mem.run.id, signal);
        // Wait for the run to move before deciding again.
        while (mem.events.length === before && mem.run.status !== "done") {
          await new Promise((r) => setTimeout(r, 2));
        }
      }
    }
  }
  return { ...mem, result: await done };
}
