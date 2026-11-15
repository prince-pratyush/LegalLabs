import { createHash } from "node:crypto";
import {
  type ExportFormat,
  LIBRARY_LIMITS,
  type LibraryGrant,
  type PromptInput,
  promptVariables,
  type TemplateFields,
} from "@legallabs/contracts";
import {
  buildDocx,
  buildPdf,
  markdownBlocks,
  openTemplate,
  placeholders,
  TemplateError,
} from "@legallabs/docx";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp } from "../db.js";

export type Access = "owner" | "manage" | "edit" | "use";
/** A partial update; a field left out or undefined is unchanged. */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined };
export type LibraryKind = "prompt" | "template";

export interface Owner {
  id: string;
  name: string;
}

export interface PromptView {
  id: string;
  name: string;
  description: string | null;
  text: string;
  variables: string[];
  owner: Owner;
  access: Access;
  shared: boolean;
  updatedAt: string;
}

export interface VersionView {
  no: number;
  fileName: string;
  size: number;
  placeholders: string[];
  note: string | null;
  revertedFrom: number | null;
  createdBy: string;
  createdAt: string;
}

export interface TemplateView {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  isDefault: boolean;
  owner: Owner;
  access: Access;
  shared: boolean;
  current: VersionView;
  updatedAt: string;
}

export interface ShareView {
  principalType: LibraryGrant["principal_type"];
  principalId: string;
  label: string;
  level: LibraryGrant["level"];
}

export type LibraryFailure =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "SHARING_RESTRICTED"
  | "NOT_MEMBER"
  | "INVALID_GRANTS"
  | "NOT_DOCX"
  | "MACROS"
  | "STRICT"
  | "TOO_LARGE";

export type Result<T> = { ok: true; value: T } | { ok: false; reason: LibraryFailure };

export interface UploadedFile {
  name: string;
  bytes: Uint8Array;
}

export interface Abilities {
  /** Upload templates, share workspace-wide, set the default. */
  manage: boolean;
  /** Save prompts and export drafts. */
  draft: boolean;
}

export interface Library {
  abilities(p: Principal): Promise<Abilities>;
  listPrompts(p: Principal): Promise<PromptView[]>;
  getPrompt(p: Principal, id: string): Promise<PromptView | null>;
  createPrompt(p: Principal, input: PromptInput, client: Client): Promise<Result<PromptView>>;
  updatePrompt(
    p: Principal,
    id: string,
    patch: Patch<PromptInput>,
    client: Client,
  ): Promise<Result<PromptView>>;
  deletePrompt(p: Principal, id: string, client: Client): Promise<Result<null>>;

  listTemplates(p: Principal): Promise<TemplateView[]>;
  getTemplate(
    p: Principal,
    id: string,
  ): Promise<{ template: TemplateView; versions: VersionView[] } | null>;
  createTemplate(
    p: Principal,
    fields: TemplateFields,
    file: UploadedFile,
    client: Client,
  ): Promise<Result<TemplateView>>;
  addVersion(
    p: Principal,
    id: string,
    file: UploadedFile,
    note: string | null,
    client: Client,
  ): Promise<Result<TemplateView>>;
  revert(p: Principal, id: string, no: number, client: Client): Promise<Result<TemplateView>>;
  updateTemplate(
    p: Principal,
    id: string,
    patch: Patch<TemplateFields>,
    client: Client,
  ): Promise<Result<TemplateView>>;
  deleteTemplate(p: Principal, id: string, client: Client): Promise<Result<null>>;
  setDefault(p: Principal, id: string, on: boolean, client: Client): Promise<Result<TemplateView>>;
  file(p: Principal, id: string, no: number): Promise<UploadedFile | null>;
  /** A sample draft poured into the template, to see the firm's look before using it. */
  sample(
    p: Principal,
    id: string,
    format: ExportFormat,
    client: Client,
  ): Promise<{ bytes: Uint8Array; filename: string } | null>;

  shares(p: Principal, kind: LibraryKind, id: string): Promise<ShareView[] | null>;
  setShares(
    p: Principal,
    kind: LibraryKind,
    id: string,
    grants: LibraryGrant[],
    client: Client,
  ): Promise<Result<ShareView[]>>;
  findPrincipals(p: Principal, query: string): Promise<ShareView[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Raised by library.set_shares; anything else is a real error.
const SQL_REFUSALS = new Set<string>([
  "NOT_FOUND",
  "FORBIDDEN",
  "SHARING_RESTRICTED",
  "NOT_MEMBER",
  "INVALID_GRANTS",
]);

class Refused extends Error {
  constructor(readonly reason: LibraryFailure) {
    super(reason);
  }
}

type Db = pg.PoolClient;

// Who may do what to a row, by the same checks the policies use.
const accessSql = (type: "library_item" | "template", alias: string) =>
  `case when ${alias}.owner_id = core.current_user_id() then 'owner'
        when core.has_permission('library.manage') then 'manage'
        when core.has_access('${type}', ${alias}.id, 'edit') then 'edit'
        else 'use' end as access,
   exists (select 1 from library.shares('${type === "template" ? "template" : "prompt"}', ${alias}.id)) as shared,
   coalesce(nullif(u.name, ''), u.email) as owner_name`;

const PROMPT_SQL = `
  select p.id, p.name, p.description, p.body, p.owner_id, p.updated_at,
         ${accessSql("library_item", "p")}
    from library.prompt p join core."user" u on u.id = p.owner_id`;

const TEMPLATE_SQL = `
  select t.id, t.name, t.description, t.instructions, t.is_default, t.owner_id, t.updated_at,
         v.no, v.file_name, v.size, v.placeholders, v.note, v.reverted_from, v.created_by,
         v.created_at, ${accessSql("template", "t")}
    from library.template t
    join core."user" u on u.id = t.owner_id
    join lateral (select tv.no, tv.file_name, octet_length(tv.bytes) as size, tv.placeholders,
                         tv.note, tv.reverted_from, tv.created_by, tv.created_at
                    from library.template_version tv
                   where tv.template_id = t.id order by tv.no desc limit 1) v on true`;

const VERSION_SQL = `select no, file_name, octet_length(bytes) as size, placeholders, note,
                            reverted_from, created_by, created_at
                       from library.template_version`;

interface PromptRow {
  id: string;
  name: string;
  description: string | null;
  body: string;
  owner_id: string;
  owner_name: string;
  updated_at: Date;
  access: Access;
  shared: boolean;
}

interface VersionRow {
  no: number;
  file_name: string;
  size: number;
  placeholders: string[];
  note: string | null;
  reverted_from: number | null;
  created_by: string;
  created_at: Date;
}

interface TemplateRow extends VersionRow {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  is_default: boolean;
  owner_id: string;
  owner_name: string;
  updated_at: Date;
  access: Access;
  shared: boolean;
}

interface ShareRow {
  principal_type: ShareView["principalType"];
  principal_id: string;
  label: string;
  level: ShareView["level"];
}

const promptView = (r: PromptRow): PromptView => ({
  id: r.id,
  name: r.name,
  description: r.description,
  text: r.body,
  variables: promptVariables(r.body),
  owner: { id: r.owner_id, name: r.owner_name },
  access: r.access,
  shared: r.shared,
  updatedAt: r.updated_at.toISOString(),
});

const versionView = (r: VersionRow): VersionView => ({
  no: r.no,
  fileName: r.file_name,
  size: Number(r.size),
  placeholders: r.placeholders,
  note: r.note,
  revertedFrom: r.reverted_from,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
});

const templateView = (r: TemplateRow): TemplateView => ({
  id: r.id,
  name: r.name,
  description: r.description,
  instructions: r.instructions,
  isDefault: r.is_default,
  owner: { id: r.owner_id, name: r.owner_name },
  access: r.access,
  shared: r.shared,
  current: versionView(r),
  updatedAt: r.updated_at.toISOString(),
});

const shareView = (r: ShareRow): ShareView => ({
  principalType: r.principal_type,
  principalId: r.principal_id,
  label: r.label,
  level: r.level,
});

const canEdit = (access: Access) => access !== "use";
const canDelete = (access: Access) => access === "owner" || access === "manage";

/** Checks an upload is a Word file we can fill, and finds its placeholders. */
function readUpload(file: UploadedFile): Result<string[]> {
  if (!/\.(docx|dotx)$/i.test(file.name)) return { ok: false, reason: "NOT_DOCX" };
  if (file.bytes.byteLength > LIBRARY_LIMITS.templateBytes)
    return { ok: false, reason: "TOO_LARGE" };
  try {
    openTemplate(file.bytes);
    return { ok: true, value: placeholders(file.bytes) };
  } catch (err) {
    if (err instanceof TemplateError) return { ok: false, reason: err.problem };
    throw err;
  }
}

const SAMPLE = `# Heading one

This sample shows a draft in this template: **bold**, *italic* and plain text.

## Heading two

1. A numbered point
2. Another numbered point

- A bullet point
- Another bullet point

### Heading three

Closing paragraph.`;

export function createLibrary(pool: pg.Pool): Library {
  const audit = (
    db: Db,
    p: Principal,
    client: Client,
    action: string,
    objectType: "library_item" | "template",
    objectId: string,
    details: object,
  ) =>
    db.query("select admin.append_audit_event($1, 'user', $2, $3, $4, $5, $6, $7)", [
      action,
      p.userId,
      objectType,
      objectId,
      JSON.stringify(details),
      client.ip,
      uaHash(client),
    ]);

  // Runs `work` in one transaction; a refusal from us or from SQL rolls it back.
  async function attempt<T>(p: Principal, work: (db: Db) => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, value: await asApp(pool, p, work) };
    } catch (err) {
      if (err instanceof Refused) return { ok: false, reason: err.reason };
      const message = err instanceof Error ? err.message : "";
      if (SQL_REFUSALS.has(message)) return { ok: false, reason: message as LibraryFailure };
      throw err;
    }
  }

  const prompt = async (db: Db, id: string) =>
    (await db.query<PromptRow>(`${PROMPT_SQL} where p.id = $1`, [id])).rows[0] ?? null;
  const template = async (db: Db, id: string) =>
    (await db.query<TemplateRow>(`${TEMPLATE_SQL} where t.id = $1`, [id])).rows[0] ?? null;
  const mustFind = async <T>(row: Promise<T | null>): Promise<T> => {
    const value = await row;
    if (!value) throw new Refused("NOT_FOUND");
    return value;
  };
  const editable = async (db: Db, id: string) => {
    const row = await mustFind(template(db, id));
    if (!canEdit(row.access)) throw new Refused("FORBIDDEN");
    return row;
  };
  const allowed = async (db: Db, permission: string) => {
    const { rows } = await db.query<{ ok: boolean }>("select core.has_permission($1) ok", [
      permission,
    ]);
    if (!rows[0]?.ok) throw new Refused("FORBIDDEN");
  };

  const addVersionRow = async (
    db: Db,
    p: Principal,
    templateId: string,
    file: UploadedFile,
    marks: string[],
    extra: { note?: string | null; revertedFrom?: number } = {},
  ) => {
    // Serialised per template, so two uploads at once can't both take the same number.
    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [templateId]);
    const { rows } = await db.query<{ no: number }>(
      `insert into library.template_version
         (workspace_id, template_id, no, file_name, bytes, sha256, placeholders, note,
          reverted_from, created_by)
       select $1, $2, coalesce(max(no), 0) + 1, $3, $4, $5, $6, $7, $8, $9
         from library.template_version where template_id = $2
       returning no`,
      [
        p.workspaceId,
        templateId,
        file.name,
        Buffer.from(file.bytes),
        createHash("sha256").update(file.bytes).digest("hex"),
        marks,
        extra.note ?? null,
        extra.revertedFrom ?? null,
        p.userId,
      ],
    );
    await db.query("update library.template set updated_at = now() where id = $1", [templateId]);
    return rows[0]?.no ?? 1;
  };

  const currentShares = async (db: Db, kind: LibraryKind, id: string) =>
    (await db.query<ShareRow>("select * from library.shares($1, $2)", [kind, id])).rows.map(
      shareView,
    );

  return {
    async abilities(p) {
      return asApp(pool, p, async (db) => {
        const { rows } = await db.query<Abilities>(
          `select core.has_permission('library.manage') as manage,
                  core.has_permission('threads.use') as draft`,
        );
        return rows[0] ?? { manage: false, draft: false };
      });
    },

    async listPrompts(p) {
      return asApp(pool, p, async (db) => {
        const { rows } = await db.query<PromptRow>(
          `${PROMPT_SQL} order by p.updated_at desc, p.id desc limit 500`,
        );
        return rows.map(promptView);
      });
    },

    async getPrompt(p, id) {
      if (!UUID.test(id)) return null;
      return asApp(pool, p, async (db) => {
        const row = await prompt(db, id);
        return row ? promptView(row) : null;
      });
    },

    async createPrompt(p, input, client) {
      return attempt(p, async (db) => {
        await allowed(db, "threads.use");
        const { rows } = await db.query<{ id: string }>(
          `insert into library.prompt (workspace_id, owner_id, name, description, body)
           values ($1, $2, $3, $4, $5) returning id`,
          [p.workspaceId, p.userId, input.name, input.description || null, input.text],
        );
        const id = rows[0]?.id ?? "";
        await audit(db, p, client, "library_item.created", "library_item", id, { kind: "prompt" });
        return promptView(await mustFind(prompt(db, id)));
      });
    },

    async updatePrompt(p, id, patch, client) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      return attempt(p, async (db) => {
        const before = await mustFind(prompt(db, id));
        if (!canEdit(before.access)) throw new Refused("FORBIDDEN");
        await db.query(
          `update library.prompt
              set name = coalesce($2, name),
                  description = case when $3::boolean then $4 else description end,
                  body = coalesce($5, body), updated_at = now()
            where id = $1`,
          [
            id,
            patch.name ?? null,
            patch.description !== undefined,
            patch.description || null,
            patch.text ?? null,
          ],
        );
        await audit(db, p, client, "library_item.updated", "library_item", id, {
          kind: "prompt",
          fields: Object.keys(patch),
        });
        return promptView(await mustFind(prompt(db, id)));
      });
    },

    async deletePrompt(p, id, client) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      return attempt(p, async (db) => {
        const row = await mustFind(prompt(db, id));
        if (!canDelete(row.access)) throw new Refused("FORBIDDEN");
        await db.query("delete from library.prompt where id = $1", [id]);
        await audit(db, p, client, "library_item.deleted", "library_item", id, {
          kind: "prompt",
          name: row.name,
        });
        return null;
      });
    },

    async listTemplates(p) {
      return asApp(pool, p, async (db) => {
        const { rows } = await db.query<TemplateRow>(
          `${TEMPLATE_SQL} order by t.is_default desc, t.updated_at desc, t.id desc limit 500`,
        );
        return rows.map(templateView);
      });
    },

    async getTemplate(p, id) {
      if (!UUID.test(id)) return null;
      return asApp(pool, p, async (db) => {
        const row = await template(db, id);
        if (!row) return null;
        const { rows } = await db.query<VersionRow>(
          `${VERSION_SQL} where template_id = $1 order by no desc`,
          [id],
        );
        return { template: templateView(row), versions: rows.map(versionView) };
      });
    },

    async createTemplate(p, fields, file, client) {
      const read = readUpload(file);
      if (!read.ok) return read;
      return attempt(p, async (db) => {
        await allowed(db, "library.manage");
        const { rows } = await db.query<{ id: string }>(
          `insert into library.template (workspace_id, owner_id, name, description, instructions)
           values ($1, $2, $3, $4, $5) returning id`,
          [
            p.workspaceId,
            p.userId,
            fields.name,
            fields.description || null,
            fields.instructions || null,
          ],
        );
        const id = rows[0]?.id ?? "";
        await addVersionRow(db, p, id, file, read.value);
        await audit(db, p, client, "template.created", "template", id, {
          file_name: file.name,
          size: file.bytes.byteLength,
        });
        return templateView(await mustFind(template(db, id)));
      });
    },

    async addVersion(p, id, file, note, client) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      const read = readUpload(file);
      if (!read.ok) return read;
      return attempt(p, async (db) => {
        await editable(db, id);
        const no = await addVersionRow(db, p, id, file, read.value, { note });
        await audit(db, p, client, "template.version_added", "template", id, { no });
        return templateView(await mustFind(template(db, id)));
      });
    },

    async revert(p, id, no, client) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      return attempt(p, async (db) => {
        await editable(db, id);
        const { rows } = await db.query<{
          file_name: string;
          bytes: Buffer;
          placeholders: string[];
        }>(
          `select file_name, bytes, placeholders from library.template_version
            where template_id = $1 and no = $2`,
          [id, no],
        );
        const old = rows[0];
        if (!old) throw new Refused("NOT_FOUND");
        const file = { name: old.file_name, bytes: new Uint8Array(old.bytes) };
        const added = await addVersionRow(db, p, id, file, old.placeholders, { revertedFrom: no });
        await audit(db, p, client, "template.version_added", "template", id, {
          no: added,
          reverted_from: no,
        });
        return templateView(await mustFind(template(db, id)));
      });
    },

    async updateTemplate(p, id, patch, client) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      return attempt(p, async (db) => {
        await editable(db, id);
        await db.query(
          `update library.template
              set name = coalesce($2, name),
                  description = case when $3::boolean then $4 else description end,
                  instructions = case when $5::boolean then $6 else instructions end,
                  updated_at = now()
            where id = $1`,
          [
            id,
            patch.name ?? null,
            patch.description !== undefined,
            patch.description || null,
            patch.instructions !== undefined,
            patch.instructions || null,
          ],
        );
        await audit(db, p, client, "template.updated", "template", id, {
          fields: Object.keys(patch),
        });
        return templateView(await mustFind(template(db, id)));
      });
    },

    async deleteTemplate(p, id, client) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      return attempt(p, async (db) => {
        const row = await mustFind(template(db, id));
        if (!canDelete(row.access)) throw new Refused("FORBIDDEN");
        await db.query("delete from library.template where id = $1", [id]);
        await audit(db, p, client, "template.deleted", "template", id, { name: row.name });
        return null;
      });
    },

    async setDefault(p, id, on, client) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      return attempt(p, async (db) => {
        await mustFind(template(db, id));
        await allowed(db, "library.manage");
        await db.query("select library.set_default_template($1, $2)", [id, on]);
        await audit(db, p, client, "template.updated", "template", id, { default: on });
        return templateView(await mustFind(template(db, id)));
      });
    },

    async file(p, id, no) {
      if (!UUID.test(id)) return null;
      return asApp(pool, p, async (db) => {
        const { rows } = await db.query<{ file_name: string; bytes: Buffer }>(
          `select file_name, bytes from library.template_version
            where template_id = $1 and no = $2`,
          [id, no],
        );
        const row = rows[0];
        return row ? { name: row.file_name, bytes: new Uint8Array(row.bytes) } : null;
      });
    },

    async sample(p, id, format, client) {
      if (!UUID.test(id)) return null;
      return asApp(pool, p, async (db) => {
        const row = await template(db, id);
        if (!row) return null;
        const { rows } = await db.query<{ bytes: Buffer }>(
          "select bytes from library.template_version where template_id = $1 and no = $2",
          [id, row.no],
        );
        if (!rows[0]) return null;
        const input = {
          title: row.name,
          blocks: markdownBlocks(SAMPLE),
          author: "LegalLabs",
          date: new Date(),
          template: new Uint8Array(rows[0].bytes),
        };
        const bytes = format === "pdf" ? await buildPdf(input) : buildDocx(input);
        await audit(db, p, client, "template.exported", "template", id, {
          format,
          sample: true,
          no: row.no,
        });
        return { bytes, filename: `${row.name} sample.${format}` };
      });
    },

    async shares(p, kind, id) {
      if (!UUID.test(id)) return null;
      return asApp(pool, p, async (db) => {
        const row = kind === "prompt" ? await prompt(db, id) : await template(db, id);
        return row ? currentShares(db, kind, id) : null;
      });
    },

    async setShares(p, kind, id, grants, client) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      const objectType = kind === "prompt" ? "library_item" : "template";
      const actions = {
        added: "share.granted",
        changed: "share.changed",
        removed: "share.revoked",
      } as const;
      return attempt(p, async (db) => {
        // Hidden items look missing, never forbidden.
        if (!(kind === "prompt" ? await prompt(db, id) : await template(db, id))) {
          throw new Refused("NOT_FOUND");
        }
        const { rows } = await db.query<{
          principal_type: string;
          principal_id: string;
          level: string;
          change: "added" | "changed" | "removed" | "kept";
        }>("select * from library.set_shares($1, $2, $3::jsonb)", [
          kind,
          id,
          JSON.stringify(grants),
        ]);
        for (const r of rows) {
          if (r.change === "kept") continue;
          await audit(db, p, client, actions[r.change], objectType, id, {
            principal_type: r.principal_type,
            principal_id: r.principal_id,
            level: r.level,
          });
        }
        return currentShares(db, kind, id);
      });
    },

    async findPrincipals(p, query) {
      return asApp(pool, p, async (db) => {
        const { rows } = await db.query<{
          principal_type: "user" | "group";
          principal_id: string;
          label: string;
        }>("select * from content.find_principals($1)", [query.replaceAll("\0", "")]);
        return rows.map((r) => ({
          principalType: r.principal_type,
          principalId: r.principal_id,
          label: r.label,
          level: "use" as const,
        }));
      });
    },
  };
}
