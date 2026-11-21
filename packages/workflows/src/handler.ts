import { createHash } from "node:crypto";
import {
  type Block,
  type FileRef,
  graphOf,
  isInput,
  type Plan,
  type RoutingClass,
  refLabel,
  topoOrder,
  validateWorkflow,
  WORKFLOW_LIMITS,
  type WorkflowDefinition,
} from "@legallabs/contracts";
import type {
  RunContext,
  RunHandler,
  RunRow,
  StepFinish,
  StepOutcome,
  StepRecord,
} from "@legallabs/runs";
import { checkInputs, inputFor } from "./inputs.js";
import {
  type LoadedWorkflow,
  type ResolvedFile,
  type Spend,
  type TableColumn,
  type WorkflowPorts,
  WorkflowStepError,
} from "./ports.js";
import { type BlockValue, dedupe, type Resolved, resolveValue, substitute } from "./render.js";
import { routingClassOf } from "./routing.js";

export interface WorkflowHandlerDeps extends WorkflowPorts {
  /** Blocks run at once on independent branches; the spec's bound is 4. */
  concurrency?: number;
}

/** Plan thresholds (spec §3.5 step 2): above these an interactive run waits for approval. */
export const APPROVAL_STEPS = 10;
export const APPROVAL_DOCUMENTS = 25;

const sha = (...parts: string[]) => createHash("sha256").update(parts.join("\u0000")).digest("hex");
const labelOf = (b: Block) => ("label" in b ? b.label : "Response");
const FINISHED = new Set(["done", "skipped", "failed"]);
const ZERO: Spend = { model: "", usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0 };

/** The order steps run in: topological, with the Response last so its step ends the run. */
export function executionOrder(def: WorkflowDefinition): string[] {
  const order = topoOrder(def) ?? [];
  const response = def.blocks.find((b) => b.type === "response")?.id;
  return response ? [...order.filter((id) => id !== response), response] : order;
}

function add(a: Spend, b: Spend): Spend {
  return {
    model: b.model || a.model,
    usage: {
      input_tokens: a.usage.input_tokens + b.usage.input_tokens,
      output_tokens: a.usage.output_tokens + b.usage.output_tokens,
      cached_tokens: (a.usage.cached_tokens ?? 0) + (b.usage.cached_tokens ?? 0),
    },
    cost_usd: a.cost_usd + b.cost_usd,
  };
}

const spent = (s: Spend, routing_class: string): Partial<StepFinish> =>
  s.model
    ? {
        model: s.model,
        routing_class,
        usage: { ...s.usage, cached_tokens: s.usage.cached_tokens ?? 0 },
        cost_usd: s.cost_usd,
      }
    : {};

interface Done {
  value: BlockValue;
  summary: string;
  spend?: Spend;
  routing_class?: string;
  extra?: Record<string, unknown>;
}

type Exec =
  | { kind: "done"; done: Done }
  | { kind: "ask"; step_id: string }
  | { kind: "fail"; code: string; message: string };

/**
 * Runs a workflow version (agents-workflows.md §4.10). Each block is one `block` step at its
 * place in `executionOrder`; independent blocks after the current one run alongside it, up to
 * the concurrency bound, and the lifecycle later finds their steps already done. A retried
 * activity finds the port's result on its step row and never calls a model twice.
 */
export function createWorkflowHandler(deps: WorkflowHandlerDeps): RunHandler {
  const concurrency = Math.max(1, deps.concurrency ?? WORKFLOW_LIMITS.concurrentBlocks);

  const load = async (run: RunRow): Promise<LoadedWorkflow> => {
    const loaded = await deps.source.load(run);
    if (!loaded) throw new WorkflowStepError("NOT_FOUND", "The workflow version wasn't found.");
    return loaded;
  };

  /** Everything one call to `step` knows; rows are read once per call. */
  function session(ctx: RunContext, loaded: LoadedWorkflow) {
    const def = loaded.definition;
    const order = executionOrder(def);
    const byId = new Map(def.blocks.map((b) => [b.id, b]));
    const index = new Map(order.map((id, i) => [id, i]));
    const { prev } = graphOf(def);
    const labelled = def.blocks.filter((b): b is Block & { label: string } => "label" in b);
    const labels = labelled.map((b) => b.label);
    const byLabel = new Map(labelled.map((b) => [b.label.toLowerCase(), b]));
    const rows = new Map<number, Promise<StepRecord | null>>();
    const record = (ordinal: number) => {
      let r = rows.get(ordinal);
      if (!r) {
        r = ctx.store.step(ordinal);
        rows.set(ordinal, r);
      }
      return r;
    };
    const recordOf = (blockId: string) => record(index.get(blockId) ?? -1);
    /** A finished block's value, or null when it was skipped. */
    const blockValue = async (blockId: string): Promise<BlockValue | null> => {
      const r = await recordOf(blockId);
      if (!r || r.status === "skipped") return null;
      return (r.output.value as BlockValue | undefined) ?? { kind: "empty" };
    };
    const valueByLabel = async (ref: string) => {
      const b = byLabel.get(refLabel(ref).toLowerCase());
      return b ? blockValue(b.id) : null;
    };
    /** Resolves every reference in `text` (and the extra exact refs) before substituting. */
    const render = async (text: string): Promise<Resolved> => {
      const values = new Map<string, Resolved>();
      for (const b of labelled) {
        if (text.toLowerCase().includes(`@${b.label.toLowerCase()}`)) {
          values.set(b.label.toLowerCase(), resolveValue(await blockValue(b.id)));
        }
      }
      return substitute(
        text,
        labels,
        (label) => values.get(label.toLowerCase()) ?? resolveValue(null),
      );
    };
    return { def, order, byId, index, prev, record, recordOf, blockValue, valueByLabel, render };
  }
  type Session = ReturnType<typeof session>;

  const resolveFiles = async (run: RunRow, refs: FileRef[]) =>
    dedupe((await Promise.all(refs.map((r) => deps.files.resolve(run, r)))).flat());

  /** Context entries: a `@Label` attaches that block's output, a file ref its documents. */
  async function context(s: Session, run: RunRow, list: (string | FileRef)[]) {
    const documents: ResolvedFile[] = [];
    const tables: string[] = [];
    for (const c of list) {
      if (typeof c === "string") {
        const r = resolveValue(await s.valueByLabel(c));
        documents.push(...r.documents);
        tables.push(...r.tables);
      } else {
        documents.push(...(await resolveFiles(run, [c])));
      }
    }
    return { documents, tables };
  }

  async function inputValue(run: RunRow, block: Block, inputs: LoadedWorkflow["inputs"]) {
    const given = "label" in block ? inputFor(inputs, block.label) : undefined;
    const empty =
      given === undefined || (typeof given === "string" ? given.trim() === "" : given.length === 0);
    switch (block.type) {
      case "user_input.file": {
        const refs = empty ? (block.default_files ?? []) : (given as FileRef[]);
        if (refs.length === 0) return { kind: "empty" } as const;
        return { kind: "files", files: await resolveFiles(run, refs) } as const;
      }
      case "user_input.text": {
        const text = empty ? block.default_text : (given as string);
        return text === undefined
          ? ({ kind: "empty" } as const)
          : ({ kind: "text", text } as const);
      }
      case "user_input.select": {
        const ids = empty
          ? (block.default_option_ids ?? [])
          : typeof given === "string"
            ? [given]
            : (given as string[]);
        if (ids.length === 0) return { kind: "empty" } as const;
        const labels = ids.map((id) => block.options.find((o) => o.id === id)?.label ?? id);
        return { kind: "select", ids, labels } as const;
      }
      case "user_input.review_table": {
        const id = empty ? block.default_table_id : (given as string);
        if (!id) return { kind: "empty" } as const;
        return {
          kind: "table",
          table_id: id,
          title: block.label,
          rows_done: 0,
          rows_total: 0,
        } as const;
      }
      default:
        return { kind: "empty" } as const;
    }
  }

  /** Whether any incoming edge is live: from a block that ran, on a branch that was taken. */
  async function reached(s: Session, block: Block) {
    const preds = s.prev.get(block.id) ?? [];
    if (block.type === "response" || preds.length === 0) return true;
    for (const p of preds) {
      const r = await s.recordOf(p);
      if (!r || r.status === "skipped") continue;
      if (s.byId.get(p)?.type === "logic.conditional") {
        const taken = (r.output.value as { taken?: string[] } | undefined)?.taken ?? [];
        if (!taken.includes(block.id)) continue;
      }
      return true;
    }
    return false;
  }

  const pauses = (run: RunRow, b: Block) =>
    b.type === "review_table.generate" && b.dry_run_rows > 0 && run.interactive;

  async function execute(
    ctx: RunContext,
    s: Session,
    loaded: LoadedWorkflow,
    block: Block,
    step: StepRecord,
    keyOf: (...parts: string[]) => string,
  ): Promise<Exec> {
    const run = ctx.run;
    const saved = step.output;
    const remember = async (field: string, value: unknown) => {
      await ctx.store.mergeOutput(step.ordinal, { [field]: value });
      saved[field] = value;
    };
    // The port's result is stored before the step finishes, so a retry reuses it.
    const once = async <T>(field: string, call: () => Promise<T>): Promise<T> => {
      if (saved[field] !== undefined) return saved[field] as T;
      const result = await call();
      await remember(field, result);
      return result;
    };

    if (isInput(block)) {
      const value = await inputValue(run, block, loaded.inputs);
      const summary =
        value.kind === "files"
          ? `${value.files.length} file(s)`
          : value.kind === "empty"
            ? "Not provided"
            : "Provided";
      return { kind: "done", done: { value, summary } };
    }

    switch (block.type) {
      case "ai_action": {
        const prompt = await s.render(block.prompt);
        const ctxFiles = await context(s, run, block.context);
        const cls = routingClassOf(block) as RoutingClass;
        let model: string | undefined;
        let routing: string = cls;
        if (block.model !== "auto") {
          if (await deps.policy.permits(run, block.model)) model = block.model;
          // The block falls back to auto and the step says why (AGT-011).
          else routing = "override_blocked";
        }
        const documents = dedupe([...prompt.documents, ...ctxFiles.documents]);
        const tables = [...new Set([...prompt.tables, ...ctxFiles.tables])];
        const result = await once("result", () =>
          deps.model.complete(run, {
            routing_class: cls,
            ...(model ? { model } : {}),
            prompt: prompt.inline,
            documents,
            tables,
            sources: block.sources,
            output: block.output,
            ...(block.json_schema ? { json_schema: block.json_schema } : {}),
            deep_analysis: block.deep_analysis,
            idempotency_key: keyOf(sha(prompt.inline), model ?? "auto"),
          }),
        );
        return {
          kind: "done",
          done: {
            value: { kind: "text", text: result.text },
            summary: `Answered with ${result.text.length} characters.`,
            spend: result,
            routing_class: routing,
            extra: {
              ...(result.citations ? { citations: result.citations } : {}),
              ...(prompt.truncated ? { truncated: true } : {}),
            },
          },
        };
      }

      case "logic.conditional": {
        const chosen = await s.valueByLabel(block.on);
        const ids = chosen?.kind === "select" ? chosen.ids : [];
        // Several selections take every matching branch.
        const taken = block.branches
          .filter((br) => br.option_ids.some((o) => ids.includes(o)))
          .map((br) => br.to);
        if (taken.length === 0 && block.else_to) taken.push(block.else_to);
        return {
          kind: "done",
          done: { value: { kind: "branches", taken }, summary: `Took ${taken.length} branch(es).` },
        };
      }

      case "drafting": {
        const instructions = await s.render(block.instructions);
        const ctxFiles = await context(s, run, block.context);
        const documents = dedupe([...instructions.documents, ...ctxFiles.documents]);
        const tables = [...new Set([...instructions.tables, ...ctxFiles.tables])];
        const bases =
          block.base === undefined
            ? []
            : typeof block.base === "string"
              ? resolveValue(await s.valueByLabel(block.base)).documents
              : await resolveFiles(run, [block.base]);
        if (block.mode === "edit_file" && bases.length === 0) {
          return { kind: "fail", code: "WF_DRAFT_BASE", message: "There is no file to edit." };
        }
        const template = block.template
          ? (await resolveFiles(run, [block.template]))[0]
          : undefined;
        // Editing several files makes one document per file.
        const targets: (ResolvedFile | undefined)[] =
          block.mode === "edit_file" ? bases : [undefined];
        const files: ResolvedFile[] = [];
        let spend = ZERO;
        for (const base of targets) {
          const field = `draft:${base?.version_id ?? "new"}`;
          const result = await once(field, () =>
            deps.drafts.draft(run, {
              title: base ? `${block.label} - ${base.name}` : block.label,
              format: block.format,
              mode: block.mode,
              ...(base ? { base } : {}),
              ...(template ? { template } : {}),
              instructions: instructions.inline,
              documents: documents.filter((d) => d.version_id !== base?.version_id),
              tables,
              track_changes: block.format === "docx" && block.track_changes,
              idempotency_key: keyOf(sha(instructions.inline), base?.version_id ?? "new"),
            }),
          );
          files.push(result.file);
          spend = add(spend, result);
        }
        return {
          kind: "done",
          done: {
            value: { kind: "files", files },
            summary: `Drafted ${files.length} ${block.format} file(s).`,
            spend,
            routing_class: "draft",
            extra: { artifact_ids: files.map((f) => f.document_id) },
          },
        };
      }

      case "review_table.generate": {
        const source = resolveValue(await s.valueByLabel(block.source));
        const instructions = block.instructions ? await s.render(block.instructions) : undefined;
        const columns: TableColumn[] = block.columns.map((c) => ({
          label: c.label,
          type: c.type,
          prompt: c.prompt,
          ...(c.options ? { options: c.options } : {}),
          ...(c.depends_on ? { depends_on: c.depends_on } : {}),
        }));
        const dry = pauses(run, block);
        const first = await once("result", () =>
          deps.tables.generate(run, {
            title: block.label,
            documents: dedupe([...source.documents, ...(instructions?.documents ?? [])]),
            columns,
            ...(instructions ? { instructions: instructions.inline } : {}),
            ...(dry ? { limit_rows: block.dry_run_rows } : {}),
            idempotency_key: keyOf(dry ? "dry" : "all"),
          }),
        );
        const value: BlockValue = {
          kind: "table",
          table_id: first.table_id,
          title: block.label,
          rows_done: first.rows_done,
          rows_total: first.rows_total,
        };
        if (dry && first.rows_done < first.rows_total) {
          // Interactive runs check the first rows before paying for the rest.
          const question = {
            text: `${first.rows_done} of ${first.rows_total} rows are done. Continue with all rows?`,
            options: [
              { id: "continue", label: "Continue with all rows" },
              { id: "stop", label: `Keep the first ${first.rows_done}` },
            ],
            allow_text: false,
            allow_skip: true,
          };
          await ctx.store.finishStep(step.ordinal, {
            status: "awaiting_user",
            ...spent(first, "extract"),
            output: {
              value,
              summary: `Dry run: ${first.rows_done} of ${first.rows_total} rows.`,
              awaiting: "approval",
              allow_skip: true,
              question,
              artifact_ids: [first.table_id],
            },
          });
          await ctx.emit({ type: "question", step_id: step.id, question });
          return { kind: "ask", step_id: step.id };
        }
        return {
          kind: "done",
          done: {
            value,
            summary: `${first.rows_done} of ${first.rows_total} rows.`,
            spend: first,
            routing_class: "extract",
            extra: { artifact_ids: [first.table_id] },
          },
        };
      }

      case "review_table.select": {
        let tableId: string | null = null;
        if (block.table.startsWith("@")) {
          const v = await s.valueByLabel(block.table);
          if (v?.kind === "table") tableId = v.table_id;
        } else tableId = block.table;
        if (!tableId) {
          return { kind: "done", done: { value: { kind: "empty" }, summary: "No table." } };
        }
        const snapshot = await deps.tables.select(run, {
          table_id: tableId,
          ...(block.columns ? { columns: block.columns } : {}),
          ...(block.row_filter ? { row_filter: block.row_filter } : {}),
        });
        if (!snapshot) {
          return { kind: "fail", code: "TABLE_UNAVAILABLE", message: "That table can't be read." };
        }
        return {
          kind: "done",
          done: {
            value: { kind: "snapshot", snapshot },
            summary: `${snapshot.rows.length} row(s), ${snapshot.columns.length} column(s).`,
          },
        };
      }

      case "response": {
        type Post = {
          message_id: string;
          artifact_id?: string;
          kind: "message" | "file" | "table";
        };
        const posted = { ...((saved.posted as Record<string, Post[]> | undefined) ?? {}) };
        for (const [i, out] of block.outputs.entries()) {
          if (posted[i]) continue;
          const value = await s.valueByLabel(out.ref);
          // A skipped branch has nothing to post.
          if (value === null) continue;
          const title = out.title ?? refLabel(out.ref);
          const key = keyOf("out", String(i));
          const posts: Post[] = [];
          if (out.as === "file" && value.kind === "files") {
            for (const [n, file] of value.files.entries()) {
              const r = await deps.artifacts.file(run, {
                title,
                file,
                idempotency_key: `${key}:${n}`,
              });
              posts.push({ ...r, kind: "file" });
            }
          } else if (out.as === "table" && value.kind === "table") {
            const r = await deps.artifacts.table(run, {
              title,
              table_id: value.table_id,
              idempotency_key: key,
            });
            posts.push({ ...r, kind: "table" });
          } else {
            const r = await deps.artifacts.message(run, {
              title,
              text: resolveValue(value).inline,
              idempotency_key: key,
            });
            posts.push({ ...r, kind: "message" });
          }
          for (const p of posts) {
            await ctx.emit({
              type: "output",
              kind: p.kind,
              message_id: p.message_id,
              ...(p.artifact_id ? { artifact_id: p.artifact_id } : {}),
              title,
            });
          }
          posted[i] = posts;
          await remember("posted", posted);
        }
        const all = Object.values(posted).flat();
        return {
          kind: "done",
          done: {
            value: { kind: "empty" },
            summary: `Posted ${all.length} output(s).`,
            extra: {
              artifact_ids: all.flatMap((p) => (p.artifact_id ? [p.artifact_id] : [])),
            },
          },
        };
      }

      default:
        return { kind: "fail", code: "WF_BLOCK_UNKNOWN", message: "Unknown block." };
    }
  }

  /** Runs one block to its step row; a finished row is returned as it is. */
  async function runBlock(ctx: RunContext, s: Session, loaded: LoadedWorkflow, ordinal: number) {
    const block = s.byId.get(s.order[ordinal] as string) as Block;
    const title = labelOf(block);
    const live = await reached(s, block);
    const begun = await ctx.store.beginStep({
      ordinal,
      kind: "block",
      block_id: block.id,
      label: title,
      input: { prompt_hash: "", sources: [], documents: [] },
      idempotency_key: sha(ctx.run.id, block.id),
    });
    const step = begun.step;
    if (FINISHED.has(step.status) || step.status === "awaiting_user") return step;
    const event = (
      status: "started" | "finished" | "failed" | "skipped" | "awaiting_user",
      extra = {},
    ) =>
      ctx.emit({
        type: "step",
        step_id: step.id,
        kind: "block",
        status,
        block_id: block.id,
        title,
        ...extra,
      });
    if (begun.created) await event("started");

    if (!live) {
      await ctx.store.finishStep(ordinal, {
        status: "skipped",
        output: { summary: "Not on a branch that was taken." },
      });
      await event("skipped");
      return { ...step, status: "skipped" };
    }

    const keyOf = (...parts: string[]) => sha(ctx.run.id, block.id, ...parts);
    let out: Exec;
    try {
      out = await execute(ctx, s, loaded, block, step, keyOf);
    } catch (err) {
      if (!(err instanceof WorkflowStepError)) throw err;
      out = { kind: "fail", code: err.code, message: err.message };
    }
    if (out.kind === "ask") {
      await event("awaiting_user");
      return { ...step, status: "awaiting_user" };
    }
    if (out.kind === "fail") {
      const error = { code: out.code, message: out.message, retryable: false };
      await ctx.store.finishStep(ordinal, {
        status: "failed",
        error,
        output: { summary: out.message.slice(0, 500), error },
      });
      await event("failed");
      return { ...step, status: "failed", output: { error } };
    }
    const { done } = out;
    await ctx.store.finishStep(ordinal, {
      status: "done",
      ...(done.spend ? spent(done.spend, done.routing_class ?? "") : {}),
      output: { value: done.value, summary: done.summary.slice(0, 500), ...done.extra },
    });
    const sp = done.spend?.model ? done.spend : null;
    await event(
      "finished",
      sp
        ? {
            model: sp.model,
            usage: { input_tokens: sp.usage.input_tokens, output_tokens: sp.usage.output_tokens },
            cost_usd: sp.cost_usd,
          }
        : {},
    );
    return { ...step, status: "done" };
  }

  const outcome = (step: StepRecord, last: boolean): StepOutcome => {
    if (step.status === "failed") {
      const error = step.output.error as { code?: string; message?: string } | undefined;
      return {
        kind: "fail",
        code: error?.code ?? "STEP_FAILED",
        message: error?.message ?? "A block failed.",
      };
    }
    if (step.status === "awaiting_user") {
      return { kind: "ask", step_id: step.id, allow_skip: true, approval: true };
    }
    return last ? { kind: "done" } : { kind: "continue" };
  };

  return {
    async plan(ctx) {
      let loaded: LoadedWorkflow;
      try {
        loaded = await load(ctx.run);
      } catch (err) {
        if (err instanceof WorkflowStepError)
          return { fail: { code: err.code, message: err.message } };
        throw err;
      }
      const def = loaded.definition;
      const validation = validateWorkflow(def);
      if (validation.errors.length > 0) {
        const codes = [...new Set(validation.errors.map((e) => e.code))].join(", ");
        return { fail: { code: "WF_INVALID", message: `The workflow has errors: ${codes}.` } };
      }
      const issues = checkInputs(def, loaded.inputs);
      if (issues.length > 0) {
        return { fail: { code: "INPUT_INVALID", message: issues.map((i) => i.message).join(" ") } };
      }
      // A class no model may serve fails here, before any step; the message names the class only.
      const classes = new Set(def.blocks.map(routingClassOf).filter((c): c is RoutingClass => !!c));
      for (const cls of classes) {
        if ((await deps.policy.eligible(ctx.run, cls)).length === 0) {
          return {
            fail: {
              code: "MODEL_POLICY_NO_ELIGIBLE_MODEL",
              message: `No model is allowed for ${cls} tasks in this run.`,
            },
          };
        }
      }
      const order = executionOrder(def);
      const byId = new Map(def.blocks.map((b) => [b.id, b]));
      let documents = 0;
      const steps: Plan["steps"] = [];
      for (const id of order) {
        const b = byId.get(id) as Block;
        let docs = 0;
        if (b.type === "user_input.file") {
          const given = inputFor(loaded.inputs, b.label);
          const refs =
            Array.isArray(given) && given.length > 0
              ? (given as FileRef[])
              : (b.default_files ?? []);
          docs = (await resolveFiles(ctx.run, refs)).length;
          documents += docs;
        }
        steps.push({
          id,
          title: labelOf(b),
          sources: b.type === "ai_action" ? b.sources.map((src) => src.source) : [],
          estimate: { docs, pages: 0 },
        });
      }
      // No one can approve a scheduled run, so only an interactive one waits.
      const requiresApproval =
        ctx.run.interactive && (steps.length > APPROVAL_STEPS || documents > APPROVAL_DOCUMENTS);
      return {
        plan: {
          steps,
          estimated_cost_usd: { low: 0, high: 0 },
          editable: false,
          interactive: ctx.run.interactive,
        },
        requiresApproval,
      };
    },

    async step(ctx, ordinal) {
      const loaded = await load(ctx.run);
      const s = session(ctx, loaded);
      const last = ordinal >= s.order.length - 1;
      if (ordinal >= s.order.length) return { kind: "done" };
      const existing = await s.record(ordinal);
      if (existing && (FINISHED.has(existing.status) || existing.status === "awaiting_user")) {
        return outcome(existing, last);
      }
      // Every earlier step is finished, so a later block is ready once its own predecessors
      // are. Those run now beside this one, up to the bound.
      const batch = [ordinal];
      const primary = s.byId.get(s.order[ordinal] as string) as Block;
      if (!pauses(ctx.run, primary)) {
        for (let j = ordinal + 1; j < s.order.length && batch.length < concurrency; j++) {
          const b = s.byId.get(s.order[j] as string) as Block;
          if (b.type === "response" || pauses(ctx.run, b)) continue;
          const row = await s.record(j);
          if (row) continue;
          let ready = true;
          for (const p of s.prev.get(b.id) ?? []) {
            const at = s.index.get(p) ?? 0;
            if (at >= ordinal) {
              const r = await s.record(at);
              if (!r || !FINISHED.has(r.status) || r.status === "failed") ready = false;
            }
            if (!ready) break;
          }
          if (ready) batch.push(j);
        }
      }
      const settled = await Promise.allSettled(batch.map((k) => runBlock(ctx, s, loaded, k)));
      const mine = settled[0] as PromiseSettledResult<StepRecord>;
      // A neighbour that threw is retried when the lifecycle reaches its own step.
      if (mine.status === "rejected") throw mine.reason;
      return outcome(mine.value, last);
    },

    async answer(ctx, step, answer) {
      const loaded = await load(ctx.run);
      const block = loaded.definition.blocks.find((b) => b.id === step.block_id);
      if (block?.type !== "review_table.generate") {
        await ctx.store.mergeOutput(step.ordinal, { answer });
        return;
      }
      const first = step.output.result as Spend & {
        table_id: string;
        rows_done: number;
        rows_total: number;
      };
      const choice = (answer as { option_id?: string } | null)?.option_id;
      if (choice === "stop") {
        await ctx.store.mergeOutput(step.ordinal, {
          answer,
          summary: `Kept the first ${first.rows_done} of ${first.rows_total} rows.`,
        });
        return;
      }
      const rest =
        (step.output.rest as (Spend & { rows_done: number; rows_total: number }) | undefined) ??
        (await deps.tables.complete(ctx.run, {
          table_id: first.table_id,
          idempotency_key: sha(ctx.run.id, block.id, "rest"),
        }));
      await ctx.store.mergeOutput(step.ordinal, { rest });
      const total = add(first, rest);
      await ctx.store.finishStep(step.ordinal, {
        status: "awaiting_user",
        ...spent(total, "extract"),
        output: {
          answer,
          value: {
            ...(step.output.value as object),
            rows_done: rest.rows_done,
            rows_total: rest.rows_total,
          },
          summary: `${rest.rows_done} of ${rest.rows_total} rows.`,
        },
      });
      await ctx.emit({
        type: "step",
        step_id: step.id,
        kind: "block",
        status: "finished",
        block_id: block.id,
        title: block.label,
        model: total.model,
        usage: { input_tokens: total.usage.input_tokens, output_tokens: total.usage.output_tokens },
        cost_usd: total.cost_usd,
      });
    },

    async verify() {
      // Citation checks run per step in the model port; nothing is left to check here.
      return { ok: true };
    },
  };
}
