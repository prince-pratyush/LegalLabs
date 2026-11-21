import { z } from "zod";

/** A block's output name; `@Label` in a prompt reads it. */
export const Label = z.string().regex(/^[A-Za-z][A-Za-z0-9_ ]{0,39}$/);
export const Ref = z.string().regex(/^@[A-Za-z][A-Za-z0-9_ ]{0,39}$/);

export const FILE_KINDS = [
  "upload",
  "vault",
  "vault_folder",
  "review_table",
  "playbook",
  "template_file",
  "dms_file",
] as const;
export const FileKind = z.enum(FILE_KINDS);
export type FileKind = z.infer<typeof FileKind>;

export const SOURCE_KINDS = ["knowledge_source", "connector", "scan"] as const;
export const SourceRef = z.object({
  kind: z.enum(SOURCE_KINDS),
  source: z.string().min(1).max(200),
  filters: z.record(z.string(), z.unknown()).optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const FileRef = z.object({ kind: FileKind, ref: z.string().min(1).max(200) });
export type FileRef = z.infer<typeof FileRef>;

export const WORKFLOW_LIMITS = {
  blocks: 60,
  embeddedFiles: 50,
  aiSources: 2,
  uploadsPerInput: 50,
  aiBlocksWarn: 10,
  concurrentBlocks: 4,
} as const;

// Counts the validator reports by code are left loose here, so a definition that breaks
// them still parses and the builder is shown a stable error instead of a schema failure.
const LOOSE = 1000;
const id = z.string().min(1).max(60);
const refOrFile = z.union([Ref, FileRef]);

const UserInputFile = z.object({
  type: z.literal("user_input.file"),
  id,
  label: Label,
  prompt: z.string().max(500),
  min: z.number().int().min(0).default(1),
  max: z.number().int().min(0).max(LOOSE).default(50),
  accept: z.array(z.string().max(100)).max(50).optional(),
  optional: z.boolean().default(false),
  default_files: z.array(FileRef).max(50).optional(),
});
const UserInputText = z.object({
  type: z.literal("user_input.text"),
  id,
  label: Label,
  prompt: z.string().max(500),
  multiline: z.boolean().default(true),
  max_chars: z.number().int().min(1).max(20000).default(5000),
  optional: z.boolean().default(false),
  default_text: z.string().max(20000).optional(),
});
const UserInputSelect = z.object({
  type: z.literal("user_input.select"),
  id,
  label: Label,
  prompt: z.string().max(500),
  options: z
    .array(z.object({ id: z.string().min(1).max(60), label: z.string().max(120) }))
    .min(2)
    .max(20),
  multiple: z.boolean().default(false),
  optional: z.boolean().default(false),
  default_option_ids: z.array(z.string()).max(20).optional(),
});
const UserInputTable = z.object({
  type: z.literal("user_input.review_table"),
  id,
  label: Label,
  prompt: z.string().max(500),
  allow_rows_subset: z.boolean().default(true),
  optional: z.boolean().default(false),
  default_table_id: z.uuid().optional(),
});

const AIAction = z.object({
  type: z.literal("ai_action"),
  id,
  label: Label,
  prompt: z.string().min(1).max(20000),
  context: z.array(refOrFile).max(LOOSE).default([]),
  sources: z.array(SourceRef).max(LOOSE).default([]),
  // Only "auto", or a model on the workspace allow-list.
  model: z.string().max(200).default("auto"),
  deep_analysis: z.boolean().default(false),
  output: z.enum(["text", "markdown", "json"]).default("markdown"),
  json_schema: z.record(z.string(), z.unknown()).optional(),
  response_mode: z.enum(["auto", "answer", "edit"]).default("auto"),
});

const Conditional = z.object({
  type: z.literal("logic.conditional"),
  id,
  label: Label,
  on: Ref,
  branches: z
    .array(z.object({ option_ids: z.array(z.string()).min(1).max(20), to: id }))
    .min(1)
    .max(20),
  else_to: id.optional(),
});

const Drafting = z.object({
  type: z.literal("drafting"),
  id,
  label: Label,
  format: z.enum(["docx", "pptx", "xlsx"]),
  mode: z.enum(["from_scratch", "edit_file"]),
  base: refOrFile.optional(),
  template: FileRef.optional(),
  instructions: z.string().max(20000),
  context: z.array(refOrFile).max(LOOSE).default([]),
  track_changes: z.boolean().default(true),
});

export const COLUMN_TYPES = [
  "date",
  "currency",
  "number",
  "verbatim",
  "free",
  "classify",
  "manual",
] as const;
const ReviewTableGenerate = z.object({
  type: z.literal("review_table.generate"),
  id,
  label: Label,
  source: Ref,
  columns: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        type: z.enum(COLUMN_TYPES),
        prompt: z.string().max(5000),
        options: z.array(z.string().max(200)).max(50).optional(),
        depends_on: z.array(z.string()).max(50).optional(),
      }),
    )
    .min(1)
    .max(500),
  instructions: z.string().max(5000).optional(),
  dry_run_rows: z.number().int().min(0).max(10).default(0),
});
const TableSelection = z.object({
  type: z.literal("review_table.select"),
  id,
  label: Label,
  table: z.union([Ref, z.uuid()]),
  columns: z.array(z.string()).max(500).optional(),
  row_filter: z.record(z.string(), z.unknown()).optional(),
});

const Response = z.object({
  type: z.literal("response"),
  id,
  outputs: z
    .array(
      z.object({
        ref: Ref,
        title: z.string().max(120).optional(),
        as: z.enum(["message", "file", "table"]).default("message"),
      }),
    )
    .min(1)
    .max(20),
  allow_follow_ups: z.boolean().default(true),
});

export const Block = z.discriminatedUnion("type", [
  UserInputFile,
  UserInputText,
  UserInputSelect,
  UserInputTable,
  AIAction,
  Conditional,
  Drafting,
  ReviewTableGenerate,
  TableSelection,
  Response,
]);
export type Block = z.infer<typeof Block>;
export type BlockType = Block["type"];

export const WorkflowDefinition = z.object({
  schema: z.literal("counsel.workflow/1"),
  blocks: z.array(Block).min(2).max(WORKFLOW_LIMITS.blocks),
  edges: z.array(z.object({ from: id, to: id })).max(400),
  embedded_files: z
    .array(z.object({ document_id: z.uuid(), label: Label }))
    .max(WORKFLOW_LIMITS.embeddedFiles + 1),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

export type InputBlock = Extract<
  Block,
  { type: "user_input.file" | "user_input.text" | "user_input.select" | "user_input.review_table" }
>;
export const isInput = (block: Block): block is InputBlock => block.type.startsWith("user_input.");

// ---- references ----

const norm = (label: string) => label.toLowerCase();

/**
 * The `@Label` tokens in a text. Labels may hold spaces, so the longest known label wins;
 * a token matching none is reported with `label: null`. An `@` after a letter or digit
 * (an email address) is not a reference.
 */
export function findRefs(
  text: string,
  labels: readonly string[],
): { label: string | null; raw: string; index: number }[] {
  const known = [...labels].sort((a, b) => b.length - a.length);
  const found: { label: string | null; raw: string; index: number }[] = [];
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_@])@(?=[A-Za-z])/gu)) {
    const at = (m.index ?? 0) + 1;
    const rest = text.slice(at);
    const hit = known.find((label) => {
      if (!norm(rest).startsWith(norm(label))) return false;
      return !/[A-Za-z0-9_]/.test(rest.charAt(label.length));
    });
    if (hit) {
      found.push({ label: hit, raw: `@${rest.slice(0, hit.length)}`, index: at - 1 });
    } else {
      const word = /^[A-Za-z][A-Za-z0-9_]*/.exec(rest)?.[0] ?? "";
      found.push({ label: null, raw: `@${word}`, index: at - 1 });
    }
  }
  return found;
}

/** The label a `@Label` string names. */
export const refLabel = (ref: string) => ref.replace(/^@/, "");

type Where = { field: string; text: string; exact: boolean };

/** Every text in a block that may hold references; `exact` ones are a whole `@Label`. */
export function blockTexts(block: Block): Where[] {
  const t = (field: string, text: string | undefined, exact = false): Where[] =>
    text === undefined ? [] : [{ field, text, exact }];
  const ctx = (list: (string | FileRef)[]): Where[] =>
    list.flatMap((c, i) => (typeof c === "string" ? t(`context[${i}]`, c, true) : []));
  switch (block.type) {
    case "ai_action":
      return [...t("prompt", block.prompt), ...ctx(block.context)];
    case "logic.conditional":
      return t("on", block.on, true);
    case "drafting":
      return [
        ...t("instructions", block.instructions),
        ...(typeof block.base === "string" ? t("base", block.base, true) : []),
        ...ctx(block.context),
      ];
    case "review_table.generate":
      return [...t("source", block.source, true), ...t("instructions", block.instructions)];
    case "review_table.select":
      return typeof block.table === "string" && block.table.startsWith("@")
        ? t("table", block.table, true)
        : [];
    case "response":
      return block.outputs.flatMap((o, i) => t(`outputs[${i}].ref`, o.ref, true));
    default:
      return [];
  }
}

export interface WorkflowIssue {
  code: string;
  block_id?: string;
  message: string;
}
export interface WorkflowValidation {
  errors: WorkflowIssue[];
  warnings: WorkflowIssue[];
}

export interface ValidateOptions {
  /** Models this user's role may name; `auto` is always allowed. Left out, none is checked. */
  allowedModels?: readonly string[];
}

/** Predecessor and successor maps over known ids only. */
export function graphOf(def: WorkflowDefinition) {
  const ids = new Set(def.blocks.map((b) => b.id));
  const next = new Map<string, string[]>();
  const prev = new Map<string, string[]>();
  for (const b of def.blocks) {
    next.set(b.id, []);
    prev.set(b.id, []);
  }
  for (const e of def.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    next.get(e.from)?.push(e.to);
    prev.get(e.to)?.push(e.from);
  }
  return { next, prev };
}

/** Block ids in an order where every block follows its predecessors; null if there is a cycle. */
export function topoOrder(def: WorkflowDefinition): string[] | null {
  const { next, prev } = graphOf(def);
  const indeg = new Map([...prev].map(([k, v]) => [k, v.length]));
  const queue = def.blocks.filter((b) => indeg.get(b.id) === 0).map((b) => b.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    order.push(cur);
    for (const n of next.get(cur) ?? []) {
      const d = (indeg.get(n) ?? 0) - 1;
      indeg.set(n, d);
      if (d === 0) queue.push(n);
    }
  }
  return order.length === def.blocks.length ? order : null;
}

function closure(start: string, edges: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(edges.get(start) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(edges.get(cur) ?? []));
  }
  return seen;
}

/** Everything downstream of a block. */
export const descendantsOf = (def: WorkflowDefinition, blockId: string) =>
  closure(blockId, graphOf(def).next);

const labelOf = (b: Block) => ("label" in b ? b.label : "Response");

/** The rules of the Workflow Builder spec: stable codes, so the canvas can mark the block. */
export function validateWorkflow(
  def: WorkflowDefinition,
  options: ValidateOptions = {},
): WorkflowValidation {
  const errors: WorkflowIssue[] = [];
  const warnings: WorkflowIssue[] = [];
  const err = (code: string, message: string, block_id?: string) =>
    errors.push(block_id === undefined ? { code, message } : { code, message, block_id });
  const warn = (code: string, message: string, block_id?: string) =>
    warnings.push(block_id === undefined ? { code, message } : { code, message, block_id });

  const byId = new Map<string, Block>();
  for (const b of def.blocks) {
    if (byId.has(b.id)) err("WF_ID_DUP", `Two blocks share the id ${b.id}.`, b.id);
    byId.set(b.id, b);
  }
  for (const e of def.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) {
      err("WF_EDGE_UNKNOWN", `An edge points at a block that doesn't exist (${e.from} → ${e.to}).`);
    }
  }
  const { next, prev } = graphOf(def);

  if (!topoOrder(def)) err("WF_CYCLE", "The blocks form a loop; a workflow must run one way.");

  const roots = def.blocks.filter((b) => (prev.get(b.id) ?? []).length === 0);
  for (const r of roots) {
    if (!isInput(r)) err("WF_NO_INPUT_START", `"${labelOf(r)}" has nothing before it.`, r.id);
  }

  const responses = def.blocks.filter((b) => b.type === "response");
  if (responses.length !== 1) {
    err("WF_RESPONSE_REQUIRED", "A workflow needs exactly one Response block.");
  } else {
    const resp = responses[0] as Block;
    if ((next.get(resp.id) ?? []).length > 0) {
      err("WF_RESPONSE_REQUIRED", "The Response block must be last.", resp.id);
    }
    for (const r of roots) {
      if (r.id !== resp.id && !closure(r.id, next).has(resp.id)) {
        err("WF_RESPONSE_REQUIRED", `"${labelOf(r)}" never reaches the Response.`, r.id);
      }
    }
  }

  const reach = new Set<string>();
  for (const r of roots) {
    reach.add(r.id);
    for (const d of closure(r.id, next)) reach.add(d);
  }
  for (const b of def.blocks) {
    if (!reach.has(b.id)) err("WF_UNREACHABLE", `"${labelOf(b)}" can't be reached.`, b.id);
  }

  const labelled = def.blocks.filter(
    (b): b is Block & { label: string } => "label" in b && typeof b.label === "string",
  );
  const byLabel = new Map<string, Block & { label: string }>();
  for (const b of labelled) {
    const key = norm(b.label);
    if (byLabel.has(key)) err("WF_LABEL_DUP", `The label "${b.label}" is used twice.`, b.id);
    else byLabel.set(key, b);
  }
  const labels = labelled.map((b) => b.label);

  const ancestors = new Map<string, Set<string>>();
  const ancestorsOf = (blockId: string) => {
    let set = ancestors.get(blockId);
    if (!set) {
      set = closure(blockId, prev);
      ancestors.set(blockId, set);
    }
    return set;
  };
  const checkLabel = (b: Block, label: string | null, raw: string) => {
    const target = label === null ? undefined : byLabel.get(norm(label));
    if (!target) err("WF_REF_UNKNOWN", `${raw} doesn't match any block label.`, b.id);
    else if (!ancestorsOf(b.id).has(target.id)) {
      err("WF_REF_NOT_UPSTREAM", `${raw} isn't before this block.`, b.id);
    }
  };
  for (const b of def.blocks) {
    for (const w of blockTexts(b)) {
      if (w.exact) checkLabel(b, refLabel(w.text), w.text);
      else for (const r of findRefs(w.text, labels)) checkLabel(b, r.label, r.raw);
    }
  }

  for (const b of def.blocks) {
    if (b.type !== "logic.conditional") continue;
    const on = byLabel.get(norm(refLabel(b.on)));
    if (on && on.type !== "user_input.select") {
      err("WF_COND_NOT_SELECT", `"${b.label}" must read a selection input.`, b.id);
    }
    const options = on?.type === "user_input.select" ? new Set(on.options.map((o) => o.id)) : null;
    const used = new Set<string>();
    const successors = new Set(next.get(b.id) ?? []);
    for (const br of b.branches) {
      for (const o of br.option_ids) {
        if (options && !options.has(o)) {
          err("WF_COND_OPTION_UNKNOWN", `Option ${o} isn't on that selection.`, b.id);
        }
        if (used.has(o)) err("WF_COND_OPTION_UNKNOWN", `Option ${o} is in two branches.`, b.id);
        used.add(o);
      }
      if (!successors.has(br.to)) {
        err("WF_COND_TARGET", `A branch must lead straight to the next block (${br.to}).`, b.id);
      }
    }
    if (b.else_to !== undefined && !successors.has(b.else_to)) {
      err("WF_COND_TARGET", "The else branch must lead straight to the next block.", b.id);
    }
  }

  const uploads = new Set(def.embedded_files.map((f) => f.document_id));
  if (def.embedded_files.length > WORKFLOW_LIMITS.embeddedFiles) {
    err("WF_EMBEDDED_MAX", `A workflow holds up to ${WORKFLOW_LIMITS.embeddedFiles} files.`);
  }
  const embeddedLabels = new Set<string>();
  for (const f of def.embedded_files) {
    if (embeddedLabels.has(norm(f.label))) {
      err("WF_LABEL_DUP", `The file label "${f.label}" is used twice.`);
    }
    embeddedLabels.add(norm(f.label));
  }
  const checkFile = (b: Block, f: FileRef) => {
    if (f.kind === "upload" && !uploads.has(f.ref)) {
      err("WF_EMBEDDED_MAX", "An uploaded file isn't listed in the workflow's files.", b.id);
    }
  };
  let aiBlocks = 0;
  for (const b of def.blocks) {
    switch (b.type) {
      case "user_input.file":
        if (b.max > WORKFLOW_LIMITS.uploadsPerInput) {
          err(
            "WF_UPLOAD_MAX",
            `"${b.label}" takes up to ${WORKFLOW_LIMITS.uploadsPerInput} files.`,
            b.id,
          );
        }
        for (const f of b.default_files ?? []) checkFile(b, f);
        break;
      case "ai_action":
        aiBlocks += 1;
        if (b.sources.length > WORKFLOW_LIMITS.aiSources) {
          err("WF_SOURCES_MAX", `"${b.label}" can use ${WORKFLOW_LIMITS.aiSources} sources.`, b.id);
        }
        if (b.output === "json" && !b.json_schema) {
          err("WF_JSON_SCHEMA", `"${b.label}" gives JSON, so it needs a schema.`, b.id);
        }
        if (
          b.model !== "auto" &&
          options.allowedModels !== undefined &&
          !options.allowedModels.includes(b.model)
        ) {
          err("WF_MODEL_NOT_ALLOWED", `"${b.model}" isn't an allowed model.`, b.id);
        }
        for (const c of b.context) if (typeof c !== "string") checkFile(b, c);
        break;
      case "drafting":
        if (b.mode === "edit_file" && b.base === undefined) {
          err("WF_DRAFT_BASE", `"${b.label}" edits a file, so it needs one.`, b.id);
        }
        if (b.format !== "docx" && b.track_changes) {
          warn("WF_TRACK_CHANGES_COERCED", "Tracked changes only apply to Word files.", b.id);
        }
        if (typeof b.base === "object") checkFile(b, b.base);
        if (b.template) checkFile(b, b.template);
        for (const c of b.context) if (typeof c !== "string") checkFile(b, c);
        break;
      case "response":
        for (const o of b.outputs) {
          const t = byLabel.get(norm(refLabel(o.ref)));
          if (!t) continue;
          if (o.as === "file" && t.type !== "drafting") {
            err("WF_OUTPUT_REF_KIND", `${o.ref} isn't a document, so it can't be a file.`, b.id);
          }
          if (o.as === "table" && !t.type.startsWith("review_table.")) {
            err("WF_OUTPUT_REF_KIND", `${o.ref} isn't a table.`, b.id);
          }
        }
        break;
      default:
        break;
    }
  }
  if (aiBlocks > WORKFLOW_LIMITS.aiBlocksWarn) {
    warn("WF_MANY_AI_BLOCKS", `${aiBlocks} AI actions may be slow and costly.`);
  }
  for (const b of def.blocks) {
    if (!isInput(b) || !b.optional) continue;
    const hasDefault =
      (b.type === "user_input.file" && (b.default_files?.length ?? 0) > 0) ||
      (b.type === "user_input.text" && b.default_text !== undefined) ||
      (b.type === "user_input.select" && (b.default_option_ids?.length ?? 0) > 0) ||
      (b.type === "user_input.review_table" && b.default_table_id !== undefined);
    if (!hasDefault)
      warn("WF_OPTIONAL_NO_DEFAULT", `"${b.label}" is optional with no default.`, b.id);
  }
  return { errors, warnings };
}
