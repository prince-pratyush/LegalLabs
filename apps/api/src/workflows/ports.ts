import { type RoutingClass, WorkflowDefinition } from "@legallabs/contracts";
import { type Gateway, GatewayError, type TaskClass } from "@legallabs/model-gateway";
import type { RunRow } from "@legallabs/runs";
import {
  type ArtifactPort,
  type DraftPort,
  type FilePort,
  type ModelPolicy,
  type ModelPort,
  type ModelRequest,
  type ResolvedFile,
  type RunInputs,
  type TablePort,
  type WorkflowPorts,
  type WorkflowSource,
  WorkflowStepError,
} from "@legallabs/workflows";
import type pg from "pg";
import { asApp } from "../db.js";
import type { Documents } from "../documents/documents.js";
import { modelsFor, NO_MODEL_MESSAGE } from "../matters/model-policy.js";

// The ports a workflow run uses, backed by this install's database and modules. Each runs as
// the run's owner, so row-level security and walls apply to every read.
const as = (run: RunRow) => ({ userId: run.owner_id, workspaceId: run.workspace_id });

export function workflowSource(pool: pg.Pool): WorkflowSource {
  return {
    load: (run) =>
      asApp(pool, as(run), async (db) => {
        const { rows } = await db.query<{ definition: unknown; inputs: unknown; title: string }>(
          `select v.definition, r.inputs, w.title
             from work.run r
             join work.workflow_version v on v.id = r.workflow_version_id
             join work.workflow w on w.id = v.workflow_id
            where r.id = $1`,
          [run.id],
        );
        const row = rows[0];
        if (!row) return null;
        const definition = WorkflowDefinition.safeParse(row.definition);
        if (!definition.success) return null;
        return {
          definition: definition.data,
          inputs: (row.inputs ?? {}) as RunInputs,
          title: row.title,
        };
      }),
  };
}

const LIVE_FILES = 500;

/** Uploads at their latest version; vaults and folders live, as they are when the step runs. */
export function workflowFiles(pool: pg.Pool): FilePort {
  return {
    resolve: (run, ref) =>
      asApp(pool, as(run), async (db) => {
        const latest = `select d.id document_id, v.id version_id, d.name
                          from content.document d
                          join content.document_version v on v.id = (
                            select l.id from content.document_version l
                             where l.document_id = d.id order by l.version_no desc limit 1)`;
        const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!UUID.test(ref.ref)) return [];
        const query = (where: string) =>
          db.query<ResolvedFile>(`${latest} where ${where} order by d.name limit ${LIVE_FILES}`, [
            ref.ref,
          ]);
        switch (ref.kind) {
          case "upload":
            return (await query("d.id = $1")).rows;
          case "vault":
            return (await query("d.vault_id = $1")).rows;
          case "vault_folder":
            return (await query("d.folder_id = $1")).rows;
          // Playbooks, templates, tables and DMS files are attached by their own modules.
          default:
            return [];
        }
      }),
  };
}

const TASK: Record<RoutingClass, TaskClass> = {
  extract: "read_extract",
  draft: "draft_edit",
  summarise: "synthesize",
  reason: "synthesize",
};

/** The usable models per class, less what the run's matter denies. */
export function gatewayPolicy(pool: pg.Pool, gateway: Gateway): ModelPolicy {
  const models = (run: RunRow) =>
    asApp(pool, as(run), (db) =>
      modelsFor(db, gateway, { matters: [run.matter_id], threads: [run.thread_id] }),
    );
  return {
    eligible: async (run, cls) => (await models(run)).left(TASK[cls]),
    permits: async (run, model) => {
      const allowed = await models(run);
      return (["extract", "draft", "summarise", "reason"] as const).some((c) =>
        allowed.left(TASK[c]).includes(model),
      );
    },
  };
}

/** What a finished step took in, kept on its row for the policy of the steps after it. */
interface StepRead {
  value?: { files?: { version_id: string }[]; table_id?: string };
  read?: { versions?: string[]; tables?: string[] };
}

/**
 * The policy over everything a model step can draw on: the run's matter and thread, the files
 * and tables it is given, and those of earlier steps, whose output its prompt may quote.
 */
async function stepModels(pool: pg.Pool, gateway: Gateway, run: RunRow, req: ModelRequest) {
  return asApp(pool, as(run), async (db) => {
    const { rows } = await db.query<{ output: StepRead }>(
      "select output from work.run_step where run_id = $1 and kind = 'block'",
      [run.id],
    );
    return modelsFor(db, gateway, {
      matters: [run.matter_id],
      threads: [run.thread_id],
      versions: [
        ...req.documents.map((d) => d.version_id),
        ...rows.flatMap(({ output }) => [
          ...(output.value?.files?.map((f) => f.version_id) ?? []),
          ...(output.read?.versions ?? []),
        ]),
      ],
      tables: [
        ...req.tables,
        ...rows.flatMap(({ output }) => [output.value?.table_id, ...(output.read?.tables ?? [])]),
      ],
    });
  });
}

const SYSTEM =
  "You are a careful legal assistant running one step of a workflow. Answer only from the passages and text given; say so when they don't cover something. Cite passages as [document name, page].";
const PASSAGES = 20;

/** Model calls through the gateway, with passages from the step's documents as context. */
export function gatewayModel(pool: pg.Pool, gateway: Gateway, documents: Documents): ModelPort {
  return {
    async complete(run, req) {
      const models = await stepModels(pool, gateway, run, req);
      const task = TASK[req.routing_class];
      if (!models.allows(task) || !models.permits(req.model ?? "")) {
        throw new WorkflowStepError("MODEL_POLICY_NO_ELIGIBLE_MODEL", NO_MODEL_MESSAGE);
      }
      const passages =
        req.documents.length === 0
          ? []
          : await documents.search(
              { sessionId: "", userId: run.owner_id, workspaceId: run.workspace_id },
              req.prompt,
              { versionIds: req.documents.map((d) => d.version_id), limit: PASSAGES, match: "any" },
            );
      const context = passages
        .map((p) => `[${p.documentName}, page ${p.page}]\n${p.text}`)
        .join("\n\n");
      try {
        const r = await gateway.call({
          task_class: task,
          messages: [
            { role: "system", content: SYSTEM },
            {
              role: "user",
              content: context ? `${req.prompt}\n\nPassages:\n${context}` : req.prompt,
            },
          ],
          budget: { max_output: 4000, max_cost_usd: 2 },
          routing: { workspace: run.workspace_id },
          trace: req.idempotency_key,
          ...(req.model ? { model: req.model } : {}),
          ...(models.exclude.length ? { exclude: models.exclude } : {}),
        });
        return {
          model: r.model,
          usage: { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens },
          cost_usd: r.cost_usd,
          text: r.output,
        };
      } catch (err) {
        if (err instanceof GatewayError) {
          throw new WorkflowStepError("MODEL_UNAVAILABLE", "No model could answer this step.");
        }
        throw err;
      }
    },
  };
}

/** Outputs become messages in the run's thread; files are attached to it too. */
export function threadArtifacts(pool: pg.Pool): ArtifactPort {
  const post = (run: RunRow, content: string) =>
    asApp(pool, as(run), async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into work.message (workspace_id, thread_id, role, content)
         values ($1, $2, 'assistant', $3) returning id`,
        [run.workspace_id, run.thread_id, content.slice(0, 100_000)],
      );
      return rows[0]?.id as string;
    });
  const heading = (title: string | undefined, body: string) =>
    title ? `**${title}**\n\n${body}` : body;
  return {
    message: async (run, r) => ({ message_id: await post(run, heading(r.title, r.text)) }),
    async file(run, r) {
      await asApp(pool, as(run), (db) =>
        db.query(
          `insert into work.thread_document (workspace_id, thread_id, version_id)
           values ($1, $2, $3) on conflict do nothing`,
          [run.workspace_id, run.thread_id, r.file.version_id],
        ),
      );
      const message_id = await post(run, heading(r.title, `File: ${r.file.name}`));
      return { message_id, artifact_id: r.file.document_id };
    },
    async table(run, r) {
      const message_id = await post(run, heading(r.title, "Review table"));
      return { message_id, artifact_id: r.table_id };
    },
  };
}

const notConnected = (what: string) => () => {
  throw new WorkflowStepError("NOT_CONNECTED", `${what} isn't connected on this install yet.`);
};

/** Placeholders until the drafting and review-table modules supply their ports. */
export const unconnectedDrafts: DraftPort = { draft: notConnected("Drafting") };
export const unconnectedTables: TablePort = {
  generate: notConnected("Review tables"),
  complete: notConnected("Review tables"),
  select: notConnected("Review tables"),
};

export interface WorkflowPortOptions {
  gateway?: Gateway;
  documents?: Documents;
  /** Overrides, for tests and for modules wired in later. */
  ports?: Partial<WorkflowPorts>;
}

/** Every port a workflow run needs; what isn't connected fails its step with NOT_CONNECTED. */
export function workflowPorts(pool: pg.Pool, options: WorkflowPortOptions = {}): WorkflowPorts {
  const { gateway, documents } = options;
  const noModel: ModelPort = { complete: notConnected("A model") };
  const noPolicy: ModelPolicy = { eligible: async () => [], permits: async () => false };
  return {
    source: workflowSource(pool),
    files: workflowFiles(pool),
    artifacts: threadArtifacts(pool),
    model: gateway && documents ? gatewayModel(pool, gateway, documents) : noModel,
    policy: gateway ? gatewayPolicy(pool, gateway) : noPolicy,
    drafts: unconnectedDrafts,
    tables: unconnectedTables,
    ...options.ports,
  };
}
