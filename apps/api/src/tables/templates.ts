import {
  type ColumnDef,
  type CreateTableBody,
  columnKeys,
  DEFAULT_SETTINGS,
  instantiatePrompt,
  type PatchTemplateBody,
  type PutTemplateSharesBody,
  parseColumnOptions,
  type ReviewTableTemplate,
  type SaveTemplateBody,
  Settings,
  type TableErrorCode,
  type TemplateStatus,
  type TestTemplateBody,
  templateOrder,
  templatizePrompt,
} from "@legallabs/contracts";
import type pg from "pg";
import type { Client, Principal } from "../auth/auth.js";
import { asApp } from "../db.js";
import type { Notifier } from "../notifications/notify.js";
import { audit } from "./audit.js";
import type { Cells } from "./cells.js";
import {
  type Db,
  fail,
  loadColumns,
  loadTable,
  type Result,
  settingsOf,
  type Tables,
  UUID,
} from "./tables.js";

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  instructions: string;
  categories: string[];
  document_tags: string[];
  columns: ColumnDef[];
  settings: Record<string, unknown>;
  status: TemplateStatus;
  version: number;
  parent_id: string | null;
  builtin: boolean;
  owner_id: string;
  approved_by: string | null;
  rejected_note: string | null;
  my_access: "owner" | "edit" | "use";
  created_at: Date;
  updated_at: Date;
}

const SELECT = `select t.*, case when t.owner_id = core.current_user_id() then 'owner'
                                 when core.has_access('template', t.id, 'edit')
                                   or (core.has_permission('library.manage')
                                       and t.status in ('pending_approval', 'published'))
                                   then 'edit'
                                 else 'use' end my_access
                  from work.rt_template t where t.deleted_at is null`;

/** Stages at which a template may be shared: tried out, or already through approval. */
const SHAREABLE: readonly TemplateStatus[] = ["tested", "shared", "published"];

const json = (t: TemplateRow): ReviewTableTemplate => ({
  id: t.id,
  name: t.name,
  description: t.description,
  instructions: t.instructions,
  categories: t.categories,
  document_tags: t.document_tags,
  columns: t.columns,
  settings: Settings.safeParse({ ...DEFAULT_SETTINGS, ...t.settings }).data ?? DEFAULT_SETTINGS,
  status: t.status,
  version: t.version,
  parent_id: t.parent_id,
  builtin: t.builtin,
  owner_id: t.owner_id,
  approved_by: t.approved_by,
  rejected_note: t.rejected_note,
  my_access: t.my_access,
  created_at: t.created_at.toISOString(),
  updated_at: t.updated_at.toISOString(),
});

/** What the lifecycle and sharing functions raise, as the API's codes. */
const REFUSALS: Record<string, [TableErrorCode, string]> = {
  NOT_FOUND: ["NOT_FOUND", "That wasn't found."],
  FORBIDDEN: ["FORBIDDEN", "You can't do that with this template."],
  BAD_TRANSITION: [
    "TEMPLATE_BAD_TRANSITION",
    "The template isn't at a stage where that can happen. Test it first, then ask for approval.",
  ],
  INVALID_GRANTS: ["INVALID_REQUEST", "Check who the template is shared with."],
  NOT_MEMBER: ["INVALID_REQUEST", "Templates can only be shared with members of the workspace."],
  SHARING_RESTRICTED: ["FORBIDDEN", "Only a Library manager can share with everyone."],
};

function refusal(err: unknown): ReturnType<typeof fail> | null {
  const text = err instanceof Error ? err.message : "";
  const found = Object.keys(REFUSALS).find((k) => text.includes(k));
  const entry = found ? REFUSALS[found] : undefined;
  return entry ? fail(entry[0], entry[1]) : null;
}

export interface TemplateDeps {
  tables: Tables;
  cells: Pick<Cells, "runTable">;
  /** Tells an author their template was approved or rejected, with the reviewer's note. */
  notifier?: Notifier;
}

export function createTemplates(pool: pg.Pool, deps: TemplateDeps) {
  const { tables, cells, notifier } = deps;

  async function load(db: Db, id: string) {
    if (!UUID.test(id)) return null;
    const { rows } = await db.query<TemplateRow>(`${SELECT} and t.id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** Runs a lifecycle step in the database, which checks who may take it. */
  async function step(
    principal: Principal,
    id: string,
    status: TemplateStatus,
    note: string | null,
  ): Promise<Result<TemplateRow>> {
    if (!UUID.test(id)) return fail("NOT_FOUND");
    try {
      return await asApp(pool, principal, async (db) => {
        await db.query("select work.rt_template_set_status($1, $2, $3)", [id, status, note]);
        const t = await load(db, id);
        return t ? { ok: true as const, value: t } : fail("NOT_FOUND");
      });
    } catch (err) {
      const refused = refusal(err);
      if (refused) return refused;
      throw err;
    }
  }

  /**
   * Gives a table the template's instructions, settings and columns, each after the columns
   * its prompt refers to. A model the user isn't allowed is dropped, leaving the table's own.
   */
  async function apply(
    principal: Principal,
    client: Client,
    tableId: string,
    template: TemplateRow,
  ): Promise<Result<{ columns: number }>> {
    const order = templateOrder(template.columns);
    if (!order)
      return fail("TEMPLATE_INVALID", "The template's columns refer to each other in a circle.");
    const updated = await tables.update(
      principal,
      tableId,
      { instructions: template.instructions, settings: json(template).settings },
      client,
    );
    if (!updated.ok) return updated;
    const ids = new Map<string, string>();
    for (const def of order) {
      const body = {
        label: def.label,
        type: def.type,
        prompt: instantiatePrompt(def.prompt, ids),
        options: def.options,
        ...(def.language ? { language: def.language } : {}),
      };
      let made = await tables.createColumn(
        principal,
        tableId,
        { ...body, ...(def.model ? { model: def.model } : {}) },
        client,
      );
      if (!made.ok && made.code === "MODEL_NOT_ALLOWED") {
        made = await tables.createColumn(principal, tableId, body, client);
      }
      if (!made.ok) return made;
      ids.set(def.key, made.value.column.id);
    }
    return { ok: true, value: { columns: order.length } };
  }

  async function createFrom(
    principal: Principal,
    templateId: string,
    body: Omit<CreateTableBody, "template_id">,
    client: Client,
    isTest = false,
  ) {
    const template = await asApp(pool, principal, (db) => load(db, templateId));
    if (!template || template.status === "superseded") {
      return fail("NOT_FOUND", "That template wasn't found.");
    }

    const created = await tables.create(principal, body, client, { templateId, isTest });
    if (!created.ok) return created;
    const applied = await apply(principal, client, created.value.table.id, template);
    if (!applied.ok) {
      // A table with half its columns is worse than none.
      await tables.remove(principal, created.value.table.id, client);
      return applied;
    }
    await asApp(pool, principal, (db) =>
      audit(
        db,
        principal,
        client,
        "template.used",
        templateId,
        {
          table_id: created.value.table.id,
          columns: applied.value.columns,
          test: isTest,
        },
        "template",
      ),
    );
    return tables.get(principal, created.value.table.id);
  }

  return {
    createFrom,

    /** Saves a table's columns, instructions and settings as a new draft template. */
    save(principal: Principal, tableId: string, body: SaveTemplateBody, client: Client) {
      return asApp(pool, principal, async (db): Promise<Result<ReviewTableTemplate>> => {
        const table = await loadTable(db, tableId);
        if (!table) return fail("NOT_FOUND");
        const columns = await loadColumns(db, tableId);
        const keys = new Map(columns.map((c, i) => [c.id, columnKeys(columns.length)[i] ?? ""]));
        const defs: ColumnDef[] = columns.map((c) => ({
          key: keys.get(c.id) ?? "",
          label: c.label,
          type: c.type,
          prompt: templatizePrompt(c.prompt, keys),
          ...(c.language ? { language: c.language } : {}),
          ...(c.model ? { model: c.model } : {}),
          options: c.options,
        }));
        const { rows } = await db.query<{ id: string }>(
          `insert into work.rt_template
             (workspace_id, owner_id, name, description, instructions, categories, document_tags,
              columns, settings)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [
            principal.workspaceId,
            principal.userId,
            body.name,
            body.description,
            body.instructions ?? table.instructions,
            body.categories,
            body.document_tags,
            JSON.stringify(defs),
            JSON.stringify(settingsOf(table)),
          ],
        );
        const id = rows[0]?.id ?? "";
        await audit(
          db,
          principal,
          client,
          "template.created",
          id,
          {
            table_id: tableId,
            columns: defs.length,
          },
          "template",
        );
        const saved = await load(db, id);
        return { ok: true, value: json(saved as TemplateRow) };
      });
    },

    list(principal: Principal, options: { status?: string; q?: string; offset?: number }) {
      return asApp(pool, principal, async (db) => {
        const limit = 50;
        const { rows } = await db.query<TemplateRow>(
          `${SELECT}
            and ($1::text is null or t.status = $1)
              and ($2::text is null or t.name ilike '%' || $2 || '%')
              and t.status <> 'superseded'
            order by t.updated_at desc, t.id desc limit $3 offset $4`,
          [
            options.status ?? null,
            options.q?.replace(/[\\%_]/g, (ch) => `\\${ch}`) ?? null,
            limit + 1,
            options.offset ?? 0,
          ],
        );
        return {
          items: rows.slice(0, limit).map(json),
          next_cursor: rows.length > limit ? String((options.offset ?? 0) + limit) : null,
        };
      });
    },

    get(principal: Principal, id: string) {
      return asApp(pool, principal, async (db): Promise<Result<ReviewTableTemplate>> => {
        const t = await load(db, id);
        return t ? { ok: true, value: json(t) } : fail("NOT_FOUND");
      });
    },

    /** Edits a draft in place. Editing a published template starts a new draft of it. */
    async patch(principal: Principal, id: string, body: PatchTemplateBody, client: Client) {
      return asApp(pool, principal, async (db): Promise<Result<ReviewTableTemplate>> => {
        const t = await load(db, id);
        if (!t) return fail("NOT_FOUND");
        if (t.my_access === "use")
          return fail("FORBIDDEN", "You can use this template, not change it.");
        if (body.columns && !templateOrder(body.columns)) {
          return fail("TEMPLATE_INVALID", "The columns refer to each other in a circle.");
        }
        const bad = body.columns?.find((c) => !parseColumnOptions(c.type, c.options).success);
        if (bad) return fail("TEMPLATE_INVALID", `The options of ${bad.label} don't fit its type.`);
        const settings = body.settings ? { ...json(t).settings, ...body.settings } : null;
        let target = t;
        if (t.status === "published") {
          // The published version keeps serving until the new draft is approved.
          const { rows } = await db.query<{ id: string }>(
            `insert into work.rt_template
               (workspace_id, owner_id, name, description, instructions, categories,
                document_tags, columns, settings, version, parent_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
            [
              principal.workspaceId,
              principal.userId,
              t.name,
              t.description,
              t.instructions,
              t.categories,
              t.document_tags,
              JSON.stringify(t.columns),
              JSON.stringify(t.settings),
              t.version + 1,
              t.id,
            ],
          );
          target = (await load(db, rows[0]?.id ?? "")) as TemplateRow;
        } else if (t.status === "pending_approval") {
          return fail(
            "TEMPLATE_BAD_TRANSITION",
            "It is waiting for approval. Ask for it back before changing it.",
          );
        }
        await db.query(
          `update work.rt_template
              set name = coalesce($2, name), description = coalesce($3, description),
                  instructions = coalesce($4, instructions), categories = coalesce($5, categories),
                  document_tags = coalesce($6, document_tags), columns = coalesce($7, columns),
                  settings = coalesce($8, settings), updated_at = now()
            where id = $1`,
          [
            target.id,
            body.name ?? null,
            body.description ?? null,
            body.instructions ?? null,
            body.categories ?? null,
            body.document_tags ?? null,
            body.columns ? JSON.stringify(body.columns) : null,
            settings && JSON.stringify(settings),
          ],
        );
        await audit(
          db,
          principal,
          client,
          "template.updated",
          target.id,
          {
            fields: Object.keys(body),
            new_version: target.id !== t.id,
          },
          "template",
        );
        // Changed content has to be tried out again before it is shared or sent for approval.
        const changesContent =
          body.columns !== undefined ||
          body.settings !== undefined ||
          body.instructions !== undefined;
        if (changesContent && (target.status === "tested" || target.status === "shared")) {
          await db.query("select work.rt_template_set_status($1, 'draft')", [target.id]);
        }
        const fresh = await load(db, target.id);
        if (!fresh) return fail("NOT_FOUND");
        return { ok: true, value: json(fresh) };
      });
    },

    remove(principal: Principal, id: string, client: Client) {
      return asApp(pool, principal, async (db): Promise<Result<null>> => {
        const t = await load(db, id);
        if (!t) return fail("NOT_FOUND");
        if (t.my_access === "use" || t.builtin) return fail("FORBIDDEN");
        await db.query("update work.rt_template set deleted_at = now() where id = $1", [id]);
        await audit(db, principal, client, "template.deleted", id, {}, "template");
        return { ok: true, value: null };
      });
    },

    shares(principal: Principal, id: string) {
      return asApp(pool, principal, async (db): Promise<Result<unknown[]>> => {
        if (!(await load(db, id))) return fail("NOT_FOUND");
        const { rows } = await db.query("select * from work.rt_template_shares($1)", [id]);
        return { ok: true, value: rows };
      });
    },

    async setShares(principal: Principal, id: string, body: PutTemplateSharesBody, client: Client) {
      if (!UUID.test(id)) return fail("NOT_FOUND");
      try {
        return await asApp(pool, principal, async (db): Promise<Result<unknown[]>> => {
          // A template is shared only once it has been tried out; taking shares away is always
          // allowed. The database function checks who may share, so a stranger still sees 404.
          if (body.grants.length > 0) {
            const t = await load(db, id);
            if (t && t.my_access !== "use" && !SHAREABLE.includes(t.status)) {
              return fail(
                "TEMPLATE_BAD_TRANSITION",
                "Test the template on a few files before sharing it.",
              );
            }
          }
          const { rows: changes } = await db.query<{ change: string }>(
            "select * from work.rt_template_set_shares($1, $2::jsonb)",
            [id, JSON.stringify(body.grants)],
          );
          await audit(
            db,
            principal,
            client,
            "template.shared",
            id,
            {
              grants: body.grants.length,
              changed: changes.filter((c) => c.change !== "kept").length,
            },
            "template",
          );
          const { rows } = await db.query("select * from work.rt_template_shares($1)", [id]);
          return { ok: true, value: rows };
        });
      } catch (err) {
        const refused = refusal(err);
        if (refused) return refused;
        throw err;
      }
    },

    /** Tries the template on a few files: a table of its own that goes after a week. */
    async test(principal: Principal, id: string, body: TestTemplateBody, client: Client) {
      const made = await createFrom(
        principal,
        id,
        {
          name: "Template try-out",
          source: { kind: "vault", vault_id: body.vault_id, document_ids: body.document_ids },
        },
        client,
        true,
      );
      if (!made.ok) return made;
      const tableId = made.value.table.id;
      // A template that is already further along stays where it is.
      const stepped = await step(principal, id, "tested", null);
      const runs = await cells.runTable(principal, tableId, "pending", client);
      await asApp(pool, principal, (db) =>
        audit(
          db,
          principal,
          client,
          "template.tested",
          id,
          {
            table_id: tableId,
            documents: body.document_ids.length,
            status: stepped.ok ? stepped.value.status : "unchanged",
          },
          "template",
        ),
      );
      return {
        ok: true as const,
        value: { table_id: tableId, run_ids: runs.ok ? runs.value.run_ids : [] },
      };
    },

    async markShared(principal: Principal, id: string) {
      await step(principal, id, "shared", null);
    },

    async publish(principal: Principal, id: string, client: Client) {
      const result = await step(principal, id, "pending_approval", null);
      if (!result.ok) return result;
      await asApp(pool, principal, (db) =>
        audit(db, principal, client, "template.publish_requested", id, {}, "template"),
      );
      return { ok: true as const, value: { status: result.value.status } };
    },

    async decide(
      principal: Principal,
      id: string,
      approve: boolean,
      note: string | null,
      client: Client,
    ) {
      const result = await step(principal, id, approve ? "published" : "rejected", note);
      if (!result.ok) return result;
      await asApp(pool, principal, (db) =>
        audit(
          db,
          principal,
          client,
          approve ? "template.approved" : "template.rejected",
          id,
          {
            noted: note !== null && note !== "",
          },
          "template",
        ),
      );
      if (notifier) {
        // notify never throws, so a notification that fails can't undo the decision.
        await notifier.notify(principal, {
          kind: approve ? "table.template_approved" : "table.template_rejected",
          actorId: principal.userId,
          objectType: "table_template",
          objectId: id,
          objectTitle: result.value.name,
          people: { requester: result.value.owner_id },
          ...(!approve && note ? { detail: note } : {}),
        });
      }
      return { ok: true as const, value: json(result.value) };
    },
  };
}

export type Templates = ReturnType<typeof createTemplates>;
