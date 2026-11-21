import {
  type InputBlock,
  validateWorkflow,
  WorkflowDefinition,
  type WorkflowValidation,
} from "@legallabs/contracts";
import {
  CATALOGUE,
  checkInputs,
  type InputIssue,
  intakeForm,
  type RunInputs,
} from "@legallabs/workflows";
import type pg from "pg";
import type { z } from "zod";
import type { AgentRuns } from "../agent-runs/runs.js";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp, asWorker, RLS_REFUSED } from "../db.js";
import type { Documents } from "../documents/documents.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Access = "run" | "view" | "edit" | "full";

export interface WorkflowSummary {
  id: string;
  title: string;
  description: string | null;
  practice_areas: string[];
  tags: string[];
  status: "draft" | "live";
  catalogue: boolean;
  catalogue_key: string | null;
  category: string | null;
  owner_id: string | null;
  live_version_id: string | null;
  draft_version_id: string | null;
  my_access: Access;
  created_at: string;
  updated_at: string;
}

export interface WorkflowDetail extends WorkflowSummary {
  notes: string | null;
  live_definition: WorkflowDefinition | null;
  draft_definition: WorkflowDefinition | null;
  live_version_no: number | null;
  draft_version_no: number | null;
  /** Of the draft when there is one, else of the live version. */
  validation: WorkflowValidation | null;
}

export interface EmbeddedFile {
  document_id: string;
  label: string;
  name: string;
  size: number;
  version_no: number;
  uploaded_by: string;
  referenced_by: string[];
}

export type WorkflowFailure =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "SCHEMA_INVALID"
  | "WF_INVALID"
  | "NO_DRAFT"
  | "NOT_LIVE"
  | "INPUT_INVALID"
  | "FILE_IN_USE"
  | "UNSUPPORTED_TYPE"
  | "FILE_TOO_LARGE";

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; reason: WorkflowFailure; detail?: unknown };

const fail = (
  reason: WorkflowFailure,
  detail?: unknown,
): { ok: false; reason: WorkflowFailure; detail?: unknown } =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

export interface RunRequest {
  inputs: RunInputs;
  thread_id?: string;
  matter_id?: string;
  space_id?: string;
  /** Runs the draft in Test Mode; editors only. */
  test_mode?: boolean;
}

export interface Workflows {
  list(
    principal: Principal,
    filter?: { catalogue?: boolean; owner?: "me" | "shared" | "all"; q?: string },
  ): Promise<WorkflowSummary[]>;
  create(
    principal: Principal,
    body: { title: string; definition?: unknown },
    client: Client,
  ): Promise<Result<WorkflowDetail>>;
  get(principal: Principal, id: string): Promise<WorkflowDetail | null>;
  saveDraft(
    principal: Principal,
    id: string,
    definition: unknown,
    client: Client,
  ): Promise<Result<{ version_no: number; validation: WorkflowValidation }>>;
  validate(
    principal: Principal,
    id: string,
    definition: unknown,
  ): Promise<Result<WorkflowValidation>>;
  publish(
    principal: Principal,
    id: string,
    client: Client,
  ): Promise<Result<{ version_no: number }>>;
  intakeForm(principal: Principal, id: string): Promise<Result<{ inputs: InputBlock[] }>>;
  run(
    principal: Principal,
    id: string,
    request: RunRequest,
    client: Client,
  ): Promise<Result<{ run_id: string; thread_id: string }>>;
  files(principal: Principal, id: string): Promise<Result<EmbeddedFile[]>>;
  uploadFile(
    principal: Principal,
    id: string,
    file: { name: string; bytes: Uint8Array },
    client: Client,
  ): Promise<Result<EmbeddedFile>>;
  replaceFile(
    principal: Principal,
    id: string,
    documentId: string,
    file: { name: string; bytes: Uint8Array },
    client: Client,
  ): Promise<Result<EmbeddedFile & { affected_workflows: string[] }>>;
  removeFile(
    principal: Principal,
    id: string,
    documentId: string,
    client: Client,
  ): Promise<Result<null>>;
  duplicate(principal: Principal, id: string, client: Client): Promise<Result<WorkflowDetail>>;
  remove(principal: Principal, id: string, client: Client): Promise<Result<null>>;
}

export interface WorkflowsOptions {
  documents: Documents;
  /** Starts the run; left out, running answers NOT_LIVE so nothing half-starts. */
  agentRuns?: AgentRuns;
  /** Models a block may name for this person; left out, explicit models aren't checked. */
  allowedModels?: (principal: Principal) => readonly string[];
}

/** A new workflow's canvas: the mandatory input and Response blocks (spec §3.8). */
export const STARTER: WorkflowDefinition = WorkflowDefinition.parse({
  schema: "counsel.workflow/1",
  blocks: [
    { type: "user_input.text", id: "input", label: "Input", prompt: "What should this work on?" },
    { type: "response", id: "response", outputs: [{ ref: "@Input" }] },
  ],
  edges: [{ from: "input", to: "response" }],
  embedded_files: [],
});

const CATALOGUE_ITEMS = JSON.stringify(
  CATALOGUE.map((e) => ({
    key: e.key,
    title: e.title,
    description: e.description,
    category: e.category,
    definition: e.definition,
  })),
);

/** Puts the pre-built workflows into a workspace, or refreshes them; safe to repeat. */
export async function seedCatalogue(pool: pg.Pool, workspaceId: string): Promise<number> {
  return asWorker(pool, async (db) => {
    const { rows } = await db.query<{ n: number }>(
      "select work.seed_workflow_catalogue($1, $2) n",
      [workspaceId, CATALOGUE_ITEMS],
    );
    return rows[0]?.n ?? 0;
  });
}

/** Block ids whose file references name the document. */
export function blocksUsing(def: WorkflowDefinition | null, documentId: string): string[] {
  if (!def) return [];
  const names = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(names);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.kind === "upload" && o.ref === documentId) return true;
      return Object.values(o).some(names);
    }
    return false;
  };
  return def.blocks.filter(names).map((b) => b.id);
}

const issuesOf = (error: z.ZodError) =>
  error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message }));

type Row = {
  id: string;
  title: string;
  description: string | null;
  practice_areas: string[];
  tags: string[];
  status: "draft" | "live";
  catalogue: boolean;
  catalogue_key: string | null;
  category: string | null;
  owner_id: string | null;
  live_version_id: string | null;
  draft_version_id: string | null;
  my_access: Access;
  created_at: Date;
  updated_at: Date;
  notes: string | null;
};

const COLUMNS = `w.id, w.title, w.description, w.practice_areas, w.tags, w.status, w.catalogue,
  w.catalogue_key, w.category, w.owner_id, w.live_version_id, w.draft_version_id,
  work.workflow_level(w.id) my_access, w.created_at, w.updated_at, w.notes`;

const summary = (r: Row): WorkflowSummary => ({
  id: r.id,
  title: r.title,
  description: r.description,
  practice_areas: r.practice_areas,
  tags: r.tags,
  status: r.status,
  catalogue: r.catalogue,
  catalogue_key: r.catalogue_key,
  category: r.category,
  owner_id: r.owner_id,
  live_version_id: r.live_version_id,
  draft_version_id: r.draft_version_id,
  my_access: r.my_access,
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
});

const editable = (a: Access | null | undefined) => a === "edit" || a === "full";

export function createWorkflows(pool: pg.Pool, options: WorkflowsOptions): Workflows {
  const seeded = new Set<string>();
  const ensureCatalogue = async (workspaceId: string) => {
    if (seeded.has(workspaceId)) return;
    await seedCatalogue(pool, workspaceId);
    seeded.add(workspaceId);
  };
  const allowed = (principal: Principal) => {
    const models = options.allowedModels?.(principal);
    return models ? { allowedModels: models } : {};
  };

  const audit = (
    db: pg.PoolClient,
    principal: Principal,
    client: Client,
    action: string,
    workflowId: string,
    details: Record<string, unknown>,
  ) =>
    db.query("select admin.append_audit_event($1, 'user', $2, 'workflow', $3, $4, $5, $6)", [
      action,
      principal.userId,
      workflowId,
      JSON.stringify(details),
      client.ip,
      uaHash(client),
    ]);

  const row = async (db: pg.PoolClient, id: string) =>
    UUID.test(id)
      ? ((await db.query<Row>(`select ${COLUMNS} from work.workflow w where w.id = $1`, [id]))
          .rows[0] ?? null)
      : null;

  const version = async (db: pg.PoolClient, versionId: string | null) => {
    if (!versionId) return null;
    const { rows } = await db.query<{
      no: number;
      definition: unknown;
      validation: WorkflowValidation;
    }>("select no, definition, validation from work.workflow_version where id = $1", [versionId]);
    const v = rows[0];
    if (!v) return null;
    const parsed = WorkflowDefinition.safeParse(v.definition);
    return parsed.success ? { no: v.no, definition: parsed.data, validation: v.validation } : null;
  };

  const detail = async (db: pg.PoolClient, id: string): Promise<WorkflowDetail | null> => {
    const r = await row(db, id);
    if (!r) return null;
    const live = await version(db, r.live_version_id);
    // Runners never see a draft; the policy hides it and so does this.
    const draft = r.my_access === "run" ? null : await version(db, r.draft_version_id);
    return {
      ...summary(r),
      notes: r.notes,
      live_definition: live?.definition ?? null,
      draft_definition: draft?.definition ?? null,
      live_version_no: live?.no ?? null,
      draft_version_no: draft?.no ?? null,
      validation: draft?.validation ?? live?.validation ?? null,
    };
  };

  const addVersion = async (
    db: pg.PoolClient,
    principal: Principal,
    workflowId: string,
    definition: WorkflowDefinition,
    validation: WorkflowValidation,
  ) => {
    const { rows } = await db.query<{ id: string; no: number }>(
      `insert into work.workflow_version (workspace_id, workflow_id, no, definition, validation, created_by)
       select $1, $2, coalesce(max(v.no), 0) + 1, $3, $4, $5
         from work.workflow_version v where v.workflow_id = $2
       returning id, no`,
      [
        principal.workspaceId,
        workflowId,
        JSON.stringify(definition),
        JSON.stringify(validation),
        principal.userId,
      ],
    );
    const v = rows[0];
    if (!v) throw new Error("insert returned no version");
    await db.query(
      "update work.workflow set draft_version_id = $2, updated_at = now() where id = $1",
      [workflowId, v.id],
    );
    return v;
  };

  /** A new workflow owned by the caller, with a first draft. Null when RLS refuses. */
  const insertWorkflow = async (
    db: pg.PoolClient,
    principal: Principal,
    title: string,
    definition: WorkflowDefinition,
    extra: { description?: string | null; practice_areas?: string[] } = {},
  ) => {
    const { rows } = await db.query<{ id: string }>("select core.uuid7() id");
    const id = rows[0]?.id as string;
    // No `returning`: the read policy can't see a row in the statement that inserts it.
    await db.query(
      `insert into work.workflow (id, workspace_id, owner_id, title, description, practice_areas)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        principal.workspaceId,
        principal.userId,
        title.slice(0, 120),
        extra.description ?? null,
        extra.practice_areas ?? [],
      ],
    );
    await addVersion(
      db,
      principal,
      id,
      definition,
      validateWorkflow(definition, allowed(principal)),
    );
    return id;
  };

  const refused = (err: unknown) => (err as { code?: string }).code === RLS_REFUSED;

  return {
    async list(principal, filter = {}) {
      await ensureCatalogue(principal.workspaceId);
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<Row>(
          `select ${COLUMNS} from work.workflow w
            where ($1::boolean is null or w.catalogue = $1)
              and ($2 = 'all'
                   or ($2 = 'me' and w.owner_id = core.current_user_id())
                   or ($2 = 'shared' and not w.catalogue
                       and w.owner_id <> core.current_user_id()))
              and ($3::text is null or strpos(lower(w.title), lower($3)) > 0)
            order by w.catalogue, w.updated_at desc, w.id
            limit 200`,
          [filter.catalogue ?? null, filter.owner ?? "all", filter.q ?? null],
        );
        return rows.map(summary);
      });
    },

    async create(principal, body, client) {
      let definition = STARTER;
      if (body.definition !== undefined) {
        const parsed = WorkflowDefinition.safeParse(body.definition);
        if (!parsed.success) return fail("SCHEMA_INVALID", issuesOf(parsed.error));
        definition = parsed.data;
      }
      try {
        return await asApp(pool, principal, async (db) => {
          const id = await insertWorkflow(db, principal, body.title, definition);
          await audit(db, principal, client, "workflow.created", id, {});
          return ok((await detail(db, id)) as WorkflowDetail);
        });
      } catch (err) {
        if (refused(err)) return fail("FORBIDDEN");
        throw err;
      }
    },

    get: (principal, id) => asApp(pool, principal, (db) => detail(db, id)),

    async saveDraft(principal, id, input, client) {
      const parsed = WorkflowDefinition.safeParse(input);
      if (!parsed.success) return fail("SCHEMA_INVALID", issuesOf(parsed.error));
      return asApp(pool, principal, async (db) => {
        const r = await row(db, id);
        if (!r) return fail("NOT_FOUND");
        if (r.catalogue || !editable(r.my_access)) return fail("FORBIDDEN");
        const validation = validateWorkflow(parsed.data, allowed(principal));
        const v = await addVersion(db, principal, id, parsed.data, validation);
        await audit(db, principal, client, "workflow.draft.saved", id, { version_no: v.no });
        return ok({ version_no: v.no, validation });
      }).catch((err) => {
        if (refused(err)) return fail("FORBIDDEN");
        throw err;
      });
    },

    async validate(principal, id, input) {
      const parsed = WorkflowDefinition.safeParse(input);
      if (!parsed.success) return fail("SCHEMA_INVALID", issuesOf(parsed.error));
      const r = await asApp(pool, principal, (db) => row(db, id));
      if (!r) return fail("NOT_FOUND");
      return ok(validateWorkflow(parsed.data, allowed(principal)));
    },

    publish: (principal, id, client) =>
      asApp(pool, principal, async (db) => {
        const r = await row(db, id);
        if (!r) return fail("NOT_FOUND");
        if (r.catalogue || !editable(r.my_access)) return fail("FORBIDDEN");
        const draft = await version(db, r.draft_version_id);
        if (!draft) return fail("NO_DRAFT");
        const validation = validateWorkflow(draft.definition, allowed(principal));
        if (validation.errors.length > 0) return fail("WF_INVALID", validation);
        await db.query(
          `update work.workflow set live_version_id = draft_version_id, draft_version_id = null,
                  status = 'live', updated_at = now()
            where id = $1`,
          [id],
        );
        await audit(db, principal, client, "workflow.published", id, { version_no: draft.no });
        return ok({ version_no: draft.no });
      }),

    async intakeForm(principal, id) {
      const d = await asApp(pool, principal, (db) => detail(db, id));
      if (!d) return fail("NOT_FOUND");
      if (!d.live_definition) return fail("NOT_LIVE");
      return ok({ inputs: intakeForm(d.live_definition) });
    },

    async run(principal, id, request, client) {
      const d = await asApp(pool, principal, (db) => detail(db, id));
      if (!d) return fail("NOT_FOUND");
      const test = request.test_mode === true;
      if (test && !editable(d.my_access)) return fail("FORBIDDEN");
      const definition = test ? (d.draft_definition ?? d.live_definition) : d.live_definition;
      const versionId = test ? (d.draft_version_id ?? d.live_version_id) : d.live_version_id;
      if (!definition || !versionId || !options.agentRuns) return fail("NOT_LIVE");
      if (validateWorkflow(definition).errors.length > 0) {
        return fail("WF_INVALID", validateWorkflow(definition));
      }
      const issues: InputIssue[] = checkInputs(definition, request.inputs);
      if (issues.length > 0) return fail("INPUT_INVALID", issues);
      const started = await options.agentRuns.start(principal, {
        kind: "workflow",
        subject_id: id,
        workflow_version_id: versionId,
        title: d.title,
        run_inputs: request.inputs,
        path: "page",
        test_mode: test,
        ...(request.thread_id ? { thread_id: request.thread_id } : {}),
        ...(request.matter_id ? { matter_id: request.matter_id } : {}),
        ...(request.space_id ? { space_id: request.space_id } : {}),
      });
      await asApp(pool, principal, (db) =>
        audit(db, principal, client, "workflow.run.started", id, {
          run_id: started.run_id,
          test_mode: test,
        }),
      );
      return ok(started);
    },

    async files(principal, id) {
      return asApp(pool, principal, async (db) => {
        const d = await detail(db, id);
        if (!d) return fail("NOT_FOUND");
        if (d.my_access === "run") return fail("FORBIDDEN");
        return ok(await embedded(db, d));
      });
    },

    async uploadFile(principal, id, file, client) {
      const d = await asApp(pool, principal, (db) => detail(db, id));
      if (!d) return fail("NOT_FOUND");
      if (d.catalogue || !editable(d.my_access)) return fail("FORBIDDEN");
      const up = await options.documents.upload(
        principal,
        { name: file.name, bytes: file.bytes, matterId: null, workflowId: id },
        client,
      );
      if (!up.ok) {
        if (up.reason === "UNSUPPORTED_TYPE" || up.reason === "FILE_TOO_LARGE")
          return fail(up.reason);
        return fail("FORBIDDEN");
      }
      return ok({
        document_id: up.document.id,
        label: labelFor(up.document.name),
        name: up.document.name,
        size: up.document.size,
        version_no: 1,
        uploaded_by: principal.userId,
        referenced_by: [],
      });
    },

    async replaceFile(principal, id, documentId, file, client) {
      if (!UUID.test(documentId)) return fail("NOT_FOUND");
      const found = await asApp(pool, principal, async (db) => {
        const d = await detail(db, id);
        if (!d) return null;
        const files = await embedded(db, d);
        return { d, file: files.find((f) => f.document_id === documentId) ?? null };
      });
      if (!found?.file) return fail("NOT_FOUND");
      if (found.d.catalogue || !editable(found.d.my_access)) return fail("FORBIDDEN");
      const replaced = await options.documents.replace(principal, documentId, file, client);
      if (!replaced.ok) return fail(replaced.reason);
      // Every workflow that embeds the file reads the new version on its next run.
      const affected = await asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `select distinct w.id from work.workflow w
             left join work.workflow_version v on v.id in (w.live_version_id, w.draft_version_id)
            where w.id = (select d.workflow_id from content.document d where d.id = $1)
               or v.definition -> 'embedded_files' @> jsonb_build_array(
                    jsonb_build_object('document_id', $1::text))`,
          [documentId],
        );
        for (const r of rows) {
          await audit(db, principal, client, "workflow.file_replaced", r.id, {
            document_id: documentId,
            version_no: replaced.versionNo,
          });
        }
        return rows.map((r) => r.id);
      });
      return ok({ ...found.file, version_no: replaced.versionNo, affected_workflows: affected });
    },

    async removeFile(principal, id, documentId, client) {
      if (!UUID.test(documentId)) return fail("NOT_FOUND");
      return asApp(pool, principal, async (db) => {
        const d = await detail(db, id);
        if (!d) return fail("NOT_FOUND");
        if (d.catalogue || !editable(d.my_access)) return fail("FORBIDDEN");
        // Any block in any workflow the caller can see still using it keeps it.
        const { rows } = await db.query<{ live: unknown; draft: unknown }>(
          `select lv.definition live, dv.definition draft from work.workflow w
             left join work.workflow_version lv on lv.id = w.live_version_id
             left join work.workflow_version dv on dv.id = w.draft_version_id
            where strpos(coalesce(lv.definition::text, '') || coalesce(dv.definition::text, ''), $1) > 0`,
          [documentId],
        );
        const using = new Set<string>();
        for (const r of rows) {
          for (const def of [r.live, r.draft]) {
            const parsed = WorkflowDefinition.safeParse(def);
            if (parsed.success) for (const b of blocksUsing(parsed.data, documentId)) using.add(b);
          }
        }
        if (using.size > 0) return fail("FILE_IN_USE", { block_ids: [...using] });
        const { rows: removed } = await db.query<{ ok: boolean }>(
          "select work.remove_workflow_file($1, $2) ok",
          [id, documentId],
        );
        if (!removed[0]?.ok) return fail("NOT_FOUND");
        await audit(db, principal, client, "workflow.file_removed", id, {
          document_id: documentId,
        });
        return ok(null);
      });
    },

    async duplicate(principal, id, client) {
      try {
        return await asApp(pool, principal, async (db) => {
          const d = await detail(db, id);
          if (!d) return fail("NOT_FOUND");
          if (d.my_access === "run") return fail("FORBIDDEN");
          const definition = d.live_definition ?? d.draft_definition;
          if (!definition) return fail("NOT_LIVE");
          // Embedded files are referenced, not copied: they stay with their own workflow.
          const copy = await insertWorkflow(db, principal, `${d.title} (copy)`, definition, {
            description: d.description,
            practice_areas: d.practice_areas,
          });
          await audit(db, principal, client, "workflow.created", copy, { duplicated_from: id });
          return ok((await detail(db, copy)) as WorkflowDetail);
        });
      } catch (err) {
        if (refused(err)) return fail("FORBIDDEN");
        throw err;
      }
    },

    remove: (principal, id, client) =>
      asApp(pool, principal, async (db) => {
        if (!UUID.test(id)) return fail("NOT_FOUND");
        const r = await row(db, id);
        if (!r) return fail("NOT_FOUND");
        const { rows } = await db.query<{ ok: boolean }>("select work.delete_workflow($1) ok", [
          id,
        ]);
        if (!rows[0]?.ok) return fail("FORBIDDEN");
        await audit(db, principal, client, "workflow.deleted", id, {});
        return ok(null);
      }),
  };
}

/** A label the canvas can use for a new file: the name's letters, digits and spaces. */
export function labelFor(name: string): string {
  const stem = name
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9_ ]+/g, " ")
    .trim();
  const label = /^[A-Za-z]/.test(stem) ? stem : `File ${stem}`;
  return label.slice(0, 40).trim() || "File";
}

async function embedded(db: pg.PoolClient, d: WorkflowDetail): Promise<EmbeddedFile[]> {
  const defs = [d.live_definition, d.draft_definition];
  const listed = new Map<string, string>();
  for (const def of defs)
    for (const f of def?.embedded_files ?? []) listed.set(f.document_id, f.label);
  const { rows } = await db.query<{
    id: string;
    name: string;
    size: string;
    owner_id: string;
    version_no: number;
  }>(
    `select d.id, d.name, d.size, d.owner_id,
            (select max(v.version_no) from content.document_version v where v.document_id = d.id)
              version_no
       from content.document d
      where d.deleted_at is null and (d.workflow_id = $1 or d.id = any($2::uuid[]))
      order by d.name`,
    [d.id, [...listed.keys()]],
  );
  return rows.map((r) => ({
    document_id: r.id,
    label: listed.get(r.id) ?? labelFor(r.name),
    name: r.name,
    size: Number(r.size),
    version_no: r.version_no,
    uploaded_by: r.owner_id,
    referenced_by: [...new Set(defs.flatMap((def) => blocksUsing(def, r.id)))],
  }));
}
