import {
  DEFAULT_MATTER_OPTIONS,
  type ImportApplied,
  type ImportMode,
  type ImportPreview,
  MATTER_LIMITS,
  type Matter,
  type MatterCreate,
  type MatterImportIssue,
  type MatterOptions,
  type MatterPatch,
  matterDisplay,
  matterNumberValid,
  SUPPORTED_WALL_PROVIDERS,
  type WallCreate,
  type WallCsvChange,
  type WallCsvPreview,
  type WallEvaluation,
  type WallProviderConfig,
  type WallRow,
  type WallSyncReport,
} from "@legallabs/contracts";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp } from "../db.js";
import { CsvError, parseCsv, toCsv } from "./csv.js";

export type MatterFailure =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "ID_REGEX_MISMATCH"
  | "MATTER_EXISTS"
  | "INVALID_CSV"
  | "IMPORT_EXPIRED"
  | "WALL_EXISTS"
  | "WALL_SYNCED"
  | "INVALID_PRINCIPAL"
  | "TOO_MANY_UNRESOLVED"
  | "PROVIDER_NOT_SUPPORTED";

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; reason: MatterFailure; message?: string };

export interface ListQuery {
  q?: string;
  status?: "active" | "closed";
  allowInQueries?: boolean;
  /** The Work-in picker: only matters the caller can enter and may query. */
  picker?: boolean;
  cursor?: number;
}

export interface Acknowledgement {
  user_id: string;
  email: string;
  acknowledged_at: string;
  notice_version: number;
}

export interface WallFilters {
  matterId?: string;
  principalId?: string;
  provider?: string;
}

export interface WallProviderView {
  kind: WallProviderConfig["kind"];
  config: Record<string, unknown>;
  cadence_minutes: number | null;
  secret_ref: string | null;
  last_sync_at: string | null;
  last_status: string | null;
  supported: readonly string[];
}

export interface Matters {
  options(p: Principal): Promise<MatterOptions>;
  setOptions(p: Principal, options: MatterOptions, client: Client): Promise<Result<MatterOptions>>;
  list(p: Principal, query: ListQuery): Promise<{ items: Matter[]; nextCursor: number | null }>;
  get(p: Principal, id: string): Promise<Matter | null>;
  create(p: Principal, input: MatterCreate, client: Client): Promise<Result<Matter>>;
  update(p: Principal, id: string, patch: MatterPatch, client: Client): Promise<Result<Matter>>;
  close(p: Principal, id: string, client: Client): Promise<Result<Matter>>;
  acknowledge(
    p: Principal,
    id: string,
    client: Client,
  ): Promise<{ acknowledged_at: string; notice_version: number } | null>;
  acknowledgements(p: Principal, id: string): Promise<Result<Acknowledgement[]>>;
  current(p: Principal): Promise<Matter | null>;
  setCurrent(p: Principal, id: string | null): Promise<Result<Matter | null>>;
  importPreview(
    p: Principal,
    csv: string,
    mode: ImportMode,
    client: Client,
  ): Promise<Result<ImportPreview>>;
  importApply(p: Principal, token: string, client: Client): Promise<Result<ImportApplied>>;
  importReport(p: Principal, token: string): Promise<string | null>;

  walls(p: Principal, filters: WallFilters): Promise<Result<WallRow[]>>;
  createWall(p: Principal, input: WallCreate, client: Client): Promise<Result<WallRow>>;
  removeWall(p: Principal, id: string, client: Client): Promise<Result<null>>;
  principals(
    p: Principal,
    query: string,
  ): Promise<Result<{ principal_type: "user" | "group"; principal_id: string; label: string }[]>>;
  wallImportPreview(p: Principal, csv: string, client: Client): Promise<Result<WallCsvPreview>>;
  wallImportApply(
    p: Principal,
    token: string,
    client: Client,
  ): Promise<Result<{ matters: number; add: number; remove: number }>>;
  provider(p: Principal): Promise<Result<WallProviderView>>;
  setProvider(
    p: Principal,
    config: WallProviderConfig,
    client: Client,
  ): Promise<Result<WallProviderView>>;
  syncs(p: Principal): Promise<Result<WallSyncReport[]>>;
  evaluate(
    p: Principal,
    userId: string,
    matterId: string | null,
    client: Client,
  ): Promise<Result<WallEvaluation>>;
}

type Db = pg.PoolClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 200;

class Refused extends Error {
  constructor(
    readonly reason: MatterFailure,
    readonly detail?: string,
  ) {
    super(reason);
  }
}

interface MatterRow {
  id: string;
  client_id: string;
  client_name: string;
  matter_number: string;
  matter_name: string;
  description: string;
  notice: string | null;
  notice_version: number;
  wall_mode: Matter["wall_mode"];
  allow_in_queries: boolean;
  retention_hours: number | null;
  require_walls_for_sharing: boolean;
  model_policy: Matter["model_policy"];
  status: Matter["status"];
  source: Matter["source"];
  external_ref: string | null;
  created_by: string | null;
  acknowledged: boolean;
  walls_count: string | null;
}

const MATTER_SQL = `
  select m.id, m.client_id, m.client_name, m.matter_number, m.matter_name, m.description,
         m.notice, m.notice_version, m.wall_mode, m.allow_in_queries, m.retention_hours,
         m.require_walls_for_sharing, m.model_policy, m.status, m.source, m.external_ref,
         m.created_by,
         (m.notice is null or exists (
            select 1 from core.matter_acknowledgement a
             where a.matter_id = m.id and a.user_id = core.current_user_id()
               and a.notice_version = m.notice_version)) as acknowledged,
         case when core.has_permission('admin.matters')
              then (select count(*) from core.wall w where w.matter_id = m.id) end as walls_count
    from core.matter m`;

const matterJson = (row: MatterRow, options: MatterOptions): Matter => ({
  id: row.id,
  client_id: row.client_id,
  client_name: row.client_name,
  matter_number: row.matter_number,
  matter_name: row.matter_name,
  description: row.description,
  notice_md: row.notice,
  notice_version: row.notice_version,
  wall_mode: row.wall_mode,
  allow_in_queries: row.allow_in_queries,
  retention_hours: row.retention_hours,
  require_walls_for_sharing: row.require_walls_for_sharing,
  model_policy: row.model_policy,
  status: row.status,
  source: row.source,
  external_ref: row.external_ref,
  display: matterDisplay(row, options.display_format),
  // Spaces arrive with their own module; until then no matter has one.
  space_id: null,
  acknowledged: row.acknowledged,
  ...(row.walls_count === null ? {} : { walls_count: Number(row.walls_count) }),
});

const blankToNull = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null || value.trim() === "" ? null : value;

const MATTER_REQUIRED = ["client_id", "client_name", "matter_number", "matter_name"] as const;
const WALL_COLUMNS = ["principal_type", "principal", "effect"] as const;

interface ImportRow {
  client_id: string;
  client_name: string;
  matter_number: string;
  matter_name: string;
  description: string;
  notice: string | null;
  allow_in_queries: boolean;
  retention_hours: number | null;
  wall_mode: "open" | "allow_list";
  require_walls_for_sharing: boolean;
  status: "active" | "closed";
  external_ref: string | null;
}

interface StagedMatterRow {
  line: number;
  values: string[];
  row: ImportRow | null;
  error: string | null;
}

interface StagedWall {
  line: number;
  matter_id: string;
  matter_display: string;
  principal_type: "user" | "group";
  principal_id: string;
  principal: string;
  effect: "allow" | "deny";
}

const BOOL = new Map([
  ["true", true],
  ["false", false],
  ["", null],
]);

/** One CSV record as a matter, or the first thing wrong with it. */
function readMatterRow(
  record: Record<string, string>,
  idRegex: string | null,
): { row: ImportRow } | { error: string; column: string } {
  const get = (name: string) => (record[name] ?? "").trim();
  const limits: Record<string, number> = {
    client_id: 64,
    client_name: 200,
    matter_number: 64,
    matter_name: 200,
    description: 2000,
    notice: 5000,
    external_ref: 200,
  };
  for (const column of MATTER_REQUIRED) {
    if (!get(column)) return { error: `${column} is required.`, column };
  }
  for (const [column, max] of Object.entries(limits)) {
    if (get(column).length > max) return { error: `${column} is over ${max} characters.`, column };
    if (get(column).includes("\0")) return { error: `${column} has a NUL character.`, column };
  }
  if (!matterNumberValid(get("matter_number"), idRegex)) {
    return {
      error: "matter_number doesn't match the workspace's id pattern.",
      column: "matter_number",
    };
  }
  const flag = (column: string, fallback: boolean) => {
    const value = BOOL.get(get(column).toLowerCase());
    return value === undefined ? undefined : (value ?? fallback);
  };
  const allow = flag("allow_in_queries", true);
  if (allow === undefined)
    return { error: "allow_in_queries must be true or false.", column: "allow_in_queries" };
  const requireWalls = flag("require_walls_for_sharing", false);
  if (requireWalls === undefined) {
    return {
      error: "require_walls_for_sharing must be true or false.",
      column: "require_walls_for_sharing",
    };
  }
  const retention = get("retention_hours");
  if (retention && !(/^\d{1,6}$/.test(retention) && Number(retention) >= 3)) {
    return {
      error: "retention_hours must be a whole number of at least 3.",
      column: "retention_hours",
    };
  }
  const wallMode = get("wall_mode") || "open";
  if (wallMode !== "open" && wallMode !== "allow_list") {
    return { error: "wall_mode must be open or allow_list.", column: "wall_mode" };
  }
  const status = get("status") || "active";
  if (status !== "active" && status !== "closed") {
    return { error: "status must be active or closed.", column: "status" };
  }
  return {
    row: {
      client_id: get("client_id"),
      client_name: get("client_name"),
      matter_number: get("matter_number"),
      matter_name: get("matter_name"),
      description: get("description"),
      notice: get("notice") || null,
      allow_in_queries: allow,
      retention_hours: retention ? Number(retention) : null,
      wall_mode: wallMode,
      require_walls_for_sharing: requireWalls,
      status,
      external_ref: get("external_ref") || null,
    },
  };
}

const keyOf = (r: { client_id: string; matter_number: string }) =>
  `${r.client_id}\u0000${r.matter_number}`;

const sameMatter = (row: ImportRow, existing: MatterRow) =>
  row.client_name === existing.client_name &&
  row.matter_name === existing.matter_name &&
  row.description === existing.description &&
  row.notice === existing.notice &&
  row.allow_in_queries === existing.allow_in_queries &&
  row.retention_hours === existing.retention_hours &&
  row.wall_mode === existing.wall_mode &&
  row.require_walls_for_sharing === existing.require_walls_for_sharing &&
  row.status === existing.status &&
  row.external_ref === existing.external_ref;

const records = (header: string[], values: string[]) =>
  Object.fromEntries(header.map((name, i) => [name, values[i] ?? ""]));

export function createMatters(pool: pg.Pool): Matters {
  const audit = (
    db: Db,
    p: Principal,
    client: Client,
    action: string,
    objectType: string,
    objectId: string | null,
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

  async function attempt<T>(p: Principal, work: (db: Db) => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, value: await asApp(pool, p, work) };
    } catch (err) {
      if (err instanceof Refused) {
        return {
          ok: false,
          reason: err.reason,
          ...(err.detail === undefined ? {} : { message: err.detail }),
        };
      }
      const code = (err as { code?: string }).code;
      if (code === "42501") return { ok: false, reason: "FORBIDDEN" };
      throw err;
    }
  }

  const can = async (db: Db, permission: string) =>
    (await db.query<{ ok: boolean }>("select core.has_permission($1) ok", [permission])).rows[0]
      ?.ok === true;
  const must = async (db: Db, permission: string) => {
    if (!(await can(db, permission))) throw new Refused("FORBIDDEN");
  };

  const readOptions = async (db: Db): Promise<MatterOptions> => {
    const { rows } = await db.query<MatterOptions>(
      `select require_for_queries, user_editable, vault_association, display_format, id_regex,
              sharing_warning, allow_matter_mismatch_in_spaces
         from core.matter_options where workspace_id = core.current_workspace_id()`,
    );
    const row = rows[0];
    return row
      ? {
          ...row,
          display_format: { ...DEFAULT_MATTER_OPTIONS.display_format, ...row.display_format },
        }
      : DEFAULT_MATTER_OPTIONS;
  };

  const findMatter = async (db: Db, id: string) =>
    (await db.query<MatterRow>(`${MATTER_SQL} where m.id = $1`, [id])).rows[0] ?? null;

  const matterOut = async (db: Db, id: string) => {
    const row = await findMatter(db, id);
    if (!row) throw new Error("matter is not readable");
    return matterJson(row, await readOptions(db));
  };

  const isAdmin = (db: Db) => can(db, "admin.matters");

  const principalLabels = async (db: Db, ids: string[]) => {
    const { rows } = await db.query<{ principal_id: string; label: string }>(
      "select principal_id, label from core.wall_principals(null, $1::uuid[])",
      [ids],
    );
    return new Map(rows.map((r) => [r.principal_id, r.label]));
  };

  const wallRows = async (db: Db, where: string, params: unknown[]): Promise<WallRow[]> => {
    const options = await readOptions(db);
    const { rows } = await db.query<{
      id: string;
      matter_id: string;
      principal_type: "user" | "group";
      principal_id: string;
      effect: "allow" | "deny";
      provider: WallRow["provider"];
      synced_at: Date | null;
      created_at: Date;
      client_id: string;
      client_name: string;
      matter_number: string;
      description: string;
    }>(
      `select w.id, w.matter_id, w.principal_type, w.principal_id, w.effect, w.provider,
              w.synced_at, w.created_at, m.client_id, m.client_name, m.matter_number, m.description
         from core.wall w join core.matter m on m.id = w.matter_id
        where ${where}
        order by m.client_id, m.matter_number, w.effect desc, w.provider, w.created_at
        limit 5000`,
      params,
    );
    const labels = await principalLabels(db, [...new Set(rows.map((r) => r.principal_id))]);
    return rows.map((r) => ({
      id: r.id,
      matter_id: r.matter_id,
      matter_display: matterDisplay(r, options.display_format),
      principal_type: r.principal_type,
      principal_id: r.principal_id,
      principal_label: labels.get(r.principal_id) ?? "Unknown",
      effect: r.effect,
      provider: r.provider,
      synced_at: r.synced_at?.toISOString() ?? null,
      created_at: r.created_at.toISOString(),
    }));
  };

  const providerView = async (db: Db): Promise<WallProviderView> => {
    const { rows } = await db.query<{
      kind: WallProviderView["kind"];
      config: Record<string, unknown>;
      cadence_minutes: number | null;
      secret_ref: string | null;
      last_sync_at: Date | null;
      last_status: string | null;
    }>(
      `select kind, config, cadence_minutes, secret_ref, last_sync_at, last_status
         from core.wall_provider where workspace_id = core.current_workspace_id()`,
    );
    const row = rows[0];
    return {
      kind: row?.kind ?? "internal",
      config: row?.config ?? {},
      cadence_minutes: row?.cadence_minutes ?? null,
      secret_ref: row?.secret_ref ?? null,
      last_sync_at: row?.last_sync_at?.toISOString() ?? null,
      last_status: row?.last_status ?? null,
      supported: SUPPORTED_WALL_PROVIDERS,
    };
  };

  /** Writes a matter's fields; a changed notice starts a new version, shown again to all. */
  const writeMatter = async (
    db: Db,
    id: string,
    patch: MatterPatch,
  ): Promise<{ changed: string[]; before: MatterRow }> => {
    const before = await findMatter(db, id);
    if (!before) throw new Refused("NOT_FOUND");
    const columns: Record<string, unknown> = {};
    const set = (column: string, value: unknown) => {
      columns[column] = value;
    };
    if (patch.client_id !== undefined) set("client_id", patch.client_id);
    if (patch.client_name !== undefined) set("client_name", patch.client_name);
    if (patch.matter_number !== undefined) set("matter_number", patch.matter_number);
    if (patch.matter_name !== undefined) set("matter_name", patch.matter_name);
    if (patch.description !== undefined) set("description", patch.description);
    if (patch.notice_md !== undefined) set("notice", blankToNull(patch.notice_md));
    if (patch.wall_mode !== undefined) set("wall_mode", patch.wall_mode);
    if (patch.allow_in_queries !== undefined) set("allow_in_queries", patch.allow_in_queries);
    if (patch.retention_hours !== undefined) set("retention_hours", patch.retention_hours);
    if (patch.require_walls_for_sharing !== undefined) {
      set("require_walls_for_sharing", patch.require_walls_for_sharing);
    }
    if (patch.model_policy !== undefined) {
      set("model_policy", patch.model_policy === null ? null : JSON.stringify(patch.model_policy));
    }
    if (patch.external_ref !== undefined) set("external_ref", blankToNull(patch.external_ref));
    const changed = Object.keys(columns).filter((column) => {
      const old = (before as unknown as Record<string, unknown>)[column];
      const next = columns[column];
      return column === "model_policy"
        ? JSON.stringify(old ?? null) !== (next ?? "null")
        : old !== next;
    });
    if (changed.length === 0) return { changed, before };
    const assignments = changed.map((column, i) => `${column} = $${i + 2}`);
    if (changed.includes("notice")) assignments.push("notice_version = notice_version + 1");
    assignments.push("updated_at = now()");
    const { rowCount } = await db.query(
      `update core.matter set ${assignments.join(", ")} where id = $1`,
      [id, ...changed.map((column) => columns[column])],
    );
    if (rowCount === 0) throw new Refused("FORBIDDEN");
    return { changed, before };
  };

  const unique = (err: unknown) => (err as { code?: string }).code === "23505";

  return {
    async options(p) {
      return asApp(pool, p, readOptions);
    },

    async setOptions(p, options, client) {
      return attempt(p, async (db) => {
        await must(db, "admin.config");
        await db.query(
          `insert into core.matter_options
             (workspace_id, require_for_queries, user_editable, vault_association, display_format,
              id_regex, sharing_warning, allow_matter_mismatch_in_spaces)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (workspace_id) do update set
             require_for_queries = excluded.require_for_queries,
             user_editable = excluded.user_editable,
             vault_association = excluded.vault_association,
             display_format = excluded.display_format,
             id_regex = excluded.id_regex,
             sharing_warning = excluded.sharing_warning,
             allow_matter_mismatch_in_spaces = excluded.allow_matter_mismatch_in_spaces,
             updated_at = now()`,
          [
            p.workspaceId,
            options.require_for_queries,
            options.user_editable,
            options.vault_association,
            JSON.stringify(options.display_format),
            blankToNull(options.id_regex) ?? null,
            blankToNull(options.sharing_warning) ?? null,
            options.allow_matter_mismatch_in_spaces,
          ],
        );
        await audit(db, p, client, "matter.options_updated", "workspace", p.workspaceId, {
          require_for_queries: options.require_for_queries,
          user_editable: options.user_editable,
          vault_association: options.vault_association,
          id_regex: options.id_regex !== null,
        });
        return readOptions(db);
      });
    },

    async list(p, query) {
      return asApp(pool, p, async (db) => {
        const where: string[] = ["true"];
        const params: unknown[] = [];
        const add = (sql: string, value: unknown) => {
          params.push(value);
          where.push(sql.replace("?", `$${params.length}`));
        };
        if (query.q) {
          const pattern = `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
          add(
            `(m.client_id ilike ? or m.matter_number ilike $${params.length + 1}
              or m.client_name ilike $${params.length + 1} or m.matter_name ilike $${params.length + 1}
              or (m.client_id || '-' || m.matter_number) ilike $${params.length + 1})`,
            pattern,
          );
        }
        if (query.status) add("m.status = ?", query.status);
        if (query.allowInQueries !== undefined) add("m.allow_in_queries = ?", query.allowInQueries);
        if (query.picker) {
          // Admins see walled matters to manage them, but never to work in.
          where.push("m.status = 'active' and m.allow_in_queries and core.can_access_matter(m.id)");
        }
        const offset = query.cursor ?? 0;
        const { rows } = await db.query<MatterRow>(
          `${MATTER_SQL} where ${where.join(" and ")}
            order by m.client_id, m.matter_number, m.id
            limit ${PAGE + 1} offset ${offset}`,
          params,
        );
        const options = await readOptions(db);
        return {
          items: rows.slice(0, PAGE).map((row) => matterJson(row, options)),
          nextCursor: rows.length > PAGE ? offset + PAGE : null,
        };
      });
    },

    async get(p, id) {
      if (!UUID.test(id)) return null;
      return asApp(pool, p, async (db) => {
        const row = await findMatter(db, id);
        return row ? matterJson(row, await readOptions(db)) : null;
      });
    },

    async create(p, input, client) {
      return attempt(p, async (db) => {
        const admin = await isAdmin(db);
        const options = await readOptions(db);
        if (!admin && !options.user_editable) throw new Refused("FORBIDDEN");
        if (!matterNumberValid(input.matter_number, options.id_regex)) {
          throw new Refused("ID_REGEX_MISMATCH");
        }
        // The id comes first: the wall check can't see a row inserted by the same statement.
        const { rows } = await db.query<{ id: string }>("select core.uuid7() id");
        const id = rows[0]?.id as string;
        try {
          await db.query("savepoint create_matter");
          await db.query(
            `insert into core.matter
               (id, workspace_id, client_id, client_name, matter_number, matter_name, description,
                notice, wall_mode, allow_in_queries, retention_hours, require_walls_for_sharing,
                model_policy, external_ref, source, created_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'manual', $15)`,
            [
              id,
              p.workspaceId,
              input.client_id,
              input.client_name,
              input.matter_number,
              input.matter_name,
              input.description ?? "",
              blankToNull(input.notice_md) ?? null,
              input.wall_mode ?? "open",
              input.allow_in_queries ?? true,
              input.retention_hours ?? null,
              input.require_walls_for_sharing ?? false,
              input.model_policy ? JSON.stringify(input.model_policy) : null,
              blankToNull(input.external_ref) ?? null,
              p.userId,
            ],
          );
          await db.query("release savepoint create_matter");
        } catch (err) {
          await db.query("rollback to savepoint create_matter");
          if (unique(err)) throw new Refused("MATTER_EXISTS");
          throw err;
        }
        await audit(db, p, client, "matter.created", "matter", id, { source: "manual" });
        return matterOut(db, id);
      });
    },

    async update(p, id, patch, client) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      return attempt(p, async (db) => {
        const options = await readOptions(db);
        if (
          patch.matter_number !== undefined &&
          !matterNumberValid(patch.matter_number, options.id_regex)
        ) {
          throw new Refused("ID_REGEX_MISMATCH");
        }
        let result: Awaited<ReturnType<typeof writeMatter>>;
        try {
          await db.query("savepoint update_matter");
          result = await writeMatter(db, id, patch);
          await db.query("release savepoint update_matter");
        } catch (err) {
          await db.query("rollback to savepoint update_matter");
          if (unique(err)) throw new Refused("MATTER_EXISTS");
          throw err;
        }
        const { changed, before } = result;
        if (changed.length > 0) {
          await audit(db, p, client, "matter.updated", "matter", id, { fields: changed });
        }
        if (changed.includes("require_walls_for_sharing")) {
          await audit(db, p, client, "wall.require_sharing_toggled", "matter", id, {
            matter_id: id,
            value: !before.require_walls_for_sharing,
          });
        }
        if (changed.includes("model_policy")) {
          await audit(db, p, client, "matter.model_policy_updated", "matter", id, {});
        }
        return matterOut(db, id);
      });
    },

    async close(p, id, client) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      return attempt(p, async (db) => {
        const before = await findMatter(db, id);
        if (!before) throw new Refused("NOT_FOUND");
        if (before.status !== "closed") {
          const { rowCount } = await db.query(
            "update core.matter set status = 'closed', updated_at = now() where id = $1",
            [id],
          );
          if (rowCount === 0) throw new Refused("FORBIDDEN");
          await audit(db, p, client, "matter.closed", "matter", id, {});
        }
        return matterOut(db, id);
      });
    },

    async acknowledge(p, id, client) {
      if (!UUID.test(id)) return null;
      return asApp(pool, p, async (db) => {
        const { rows } = await db.query<{ notice_version: number; ok: boolean }>(
          "select notice_version, core.can_access_matter(id) ok from core.matter where id = $1",
          [id],
        );
        const matter = rows[0];
        if (!matter?.ok) return null;
        await db.query(
          `insert into core.matter_acknowledgement (workspace_id, user_id, matter_id, notice_version)
           values ($1, $2, $3, $4) on conflict do nothing`,
          [p.workspaceId, p.userId, id, matter.notice_version],
        );
        const { rows: written } = await db.query<{ acknowledged_at: Date }>(
          `select acknowledged_at from core.matter_acknowledgement
            where user_id = $1 and matter_id = $2 and notice_version = $3`,
          [p.userId, id, matter.notice_version],
        );
        await audit(db, p, client, "matter.notice_acknowledged", "matter", id, {
          notice_version: matter.notice_version,
        });
        return {
          acknowledged_at: (written[0]?.acknowledged_at ?? new Date()).toISOString(),
          notice_version: matter.notice_version,
        };
      });
    },

    async acknowledgements(p, id) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      return attempt(p, async (db) => {
        await must(db, "admin.matters");
        if (!(await findMatter(db, id))) throw new Refused("NOT_FOUND");
        const { rows } = await db.query<{
          user_id: string;
          acknowledged_at: Date;
          notice_version: number;
        }>(
          `select user_id, acknowledged_at, notice_version from core.matter_acknowledgement
            where matter_id = $1 order by acknowledged_at desc limit 5000`,
          [id],
        );
        const labels = await principalLabels(db, [...new Set(rows.map((r) => r.user_id))]);
        return rows.map((r) => ({
          user_id: r.user_id,
          email: labels.get(r.user_id) ?? "",
          acknowledged_at: r.acknowledged_at.toISOString(),
          notice_version: r.notice_version,
        }));
      });
    },

    async current(p) {
      return asApp(pool, p, async (db) => {
        const { rows } = await db.query<{ id: string | null }>(
          `select s.current_matter_id id from core.session s
            where s.id = $1 and core.can_access_matter(s.current_matter_id)`,
          [p.sessionId],
        );
        const id = rows[0]?.id;
        if (!id) return null;
        const row = await findMatter(db, id);
        return row ? matterJson(row, await readOptions(db)) : null;
      });
    },

    async setCurrent(p, id) {
      if (id !== null && !UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      return attempt(p, async (db) => {
        if (id !== null) {
          const { rows } = await db.query<{ ok: boolean }>(
            `select core.can_access_matter(id) and status = 'active' ok
               from core.matter where id = $1`,
            [id],
          );
          if (!rows[0]?.ok) throw new Refused("NOT_FOUND");
        }
        await db.query("update core.session set current_matter_id = $2 where id = $1", [
          p.sessionId,
          id,
        ]);
        return id === null ? null : matterOut(db, id);
      });
    },

    async importPreview(p, csv, mode, client) {
      return attempt(p, async (db) => {
        await must(db, "admin.matters");
        let table: ReturnType<typeof parseCsv>;
        try {
          table = parseCsv(csv, MATTER_LIMITS.importRows);
        } catch (err) {
          if (!(err instanceof CsvError)) throw err;
          throw new Refused(
            "INVALID_CSV",
            err.message === "TOO_MANY_ROWS"
              ? `A file can hold up to ${MATTER_LIMITS.importRows.toLocaleString("en")} matters.`
              : err.message,
          );
        }
        const missing = MATTER_REQUIRED.filter((c) => !table.header.includes(c));
        if (missing.length > 0) {
          throw new Refused("INVALID_CSV", `The header needs ${missing.join(", ")}.`);
        }
        const options = await readOptions(db);
        const existing = new Map(
          (await db.query<MatterRow>(MATTER_SQL)).rows.map((row) => [keyOf(row), row]),
        );
        const issues: MatterImportIssue[] = [];
        const staged: StagedMatterRow[] = [];
        const seen = new Set<string>();
        let add = 0;
        let update = 0;
        let unchanged = 0;
        for (const record of table.records) {
          const values = record.values;
          const read = readMatterRow(records(table.header, values), options.id_regex);
          let error: string | null = null;
          let column: string | null = null;
          if ("error" in read) {
            error = read.error;
            column = read.column;
          } else if (seen.has(keyOf(read.row))) {
            error = "This matter appears earlier in the file.";
            column = "matter_number";
          }
          if (error !== null) {
            issues.push({ line: record.line, column, message: error });
            staged.push({ line: record.line, values, row: null, error });
            continue;
          }
          if ("error" in read) continue;
          seen.add(keyOf(read.row));
          const before = existing.get(keyOf(read.row));
          if (!before) add++;
          else if (sameMatter(read.row, before)) unchanged++;
          else update++;
          staged.push({ line: record.line, values, row: read.row, error: null });
        }
        const close =
          mode === "replace_missing_as_closed"
            ? [...existing.entries()].filter(
                ([key, row]) => !seen.has(key) && row.status === "active",
              ).length
            : 0;
        const preview = { add, update, close, unchanged, issue_count: issues.length };
        const { rows } = await db.query<{ id: string }>(
          `insert into core.matter_import (workspace_id, kind, mode, rows, preview, created_by)
           values ($1, 'matters', $2, $3, $4, $5) returning id`,
          [
            p.workspaceId,
            mode,
            JSON.stringify([{ header: table.header, staged }]),
            JSON.stringify(preview),
            p.userId,
          ],
        );
        void client;
        return {
          token: rows[0]?.id as string,
          ...preview,
          issues: issues.slice(0, MATTER_LIMITS.previewIssues),
        };
      });
    },

    async importApply(p, token, client) {
      if (!UUID.test(token)) return { ok: false, reason: "NOT_FOUND" };
      return attempt(p, async (db) => {
        await must(db, "admin.matters");
        const { rows } = await db.query<{
          mode: ImportMode;
          rows: [{ header: string[]; staged: StagedMatterRow[] }];
          expired: boolean;
          applied: boolean;
        }>(
          `select mode, rows, expires_at < now() expired, applied_at is not null applied
             from core.matter_import where id = $1 and kind = 'matters' for update`,
          [token],
        );
        const job = rows[0];
        if (!job) throw new Refused("NOT_FOUND");
        if (job.expired || job.applied) throw new Refused("IMPORT_EXPIRED");
        const { header, staged } = job.rows[0];
        const options = await readOptions(db);
        const existing = new Map(
          (await db.query<MatterRow>(MATTER_SQL)).rows.map((row) => [keyOf(row), row]),
        );
        const counts = { add: 0, update: 0, close: 0 };
        const results: string[] = [];
        for (const item of staged) {
          // Re-checked here: the pattern may have changed since the preview.
          if (!item.row || !matterNumberValid(item.row.matter_number, options.id_regex)) {
            results.push(`error: ${item.error ?? "matter_number doesn't match the id pattern."}`);
            continue;
          }
          const row = item.row;
          const before = existing.get(keyOf(row));
          if (before && sameMatter(row, before)) {
            results.push("unchanged");
            continue;
          }
          await db.query(
            `insert into core.matter
               (workspace_id, client_id, client_name, matter_number, matter_name, description,
                notice, allow_in_queries, retention_hours, wall_mode, require_walls_for_sharing,
                status, external_ref, source, created_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'csv', $14)
             on conflict (workspace_id, client_id, matter_number) do update set
               client_name = excluded.client_name, matter_name = excluded.matter_name,
               description = excluded.description, notice = excluded.notice,
               notice_version = core.matter.notice_version
                 + case when core.matter.notice is distinct from excluded.notice then 1 else 0 end,
               allow_in_queries = excluded.allow_in_queries,
               retention_hours = excluded.retention_hours, wall_mode = excluded.wall_mode,
               require_walls_for_sharing = excluded.require_walls_for_sharing,
               status = excluded.status, external_ref = excluded.external_ref,
               updated_at = now()`,
            [
              p.workspaceId,
              row.client_id,
              row.client_name,
              row.matter_number,
              row.matter_name,
              row.description,
              row.notice,
              row.allow_in_queries,
              row.retention_hours,
              row.wall_mode,
              row.require_walls_for_sharing,
              row.status,
              row.external_ref,
              p.userId,
            ],
          );
          if (before) counts.update++;
          else counts.add++;
          results.push(before ? "updated" : "added");
        }
        const report = [
          [...header, "result"],
          ...staged.map((s, i) => [...s.values, results[i] ?? ""]),
        ];
        if (job.mode === "replace_missing_as_closed") {
          const present = new Set(staged.flatMap((s) => (s.row ? [keyOf(s.row)] : [])));
          const missing = [...existing.values()].filter(
            (row) => !present.has(keyOf(row)) && row.status === "active",
          );
          for (const row of missing) {
            await db.query(
              "update core.matter set status = 'closed', updated_at = now() where id = $1",
              [row.id],
            );
            counts.close++;
            report.push([
              ...header.map((h) =>
                h === "client_id" ? row.client_id : h === "matter_number" ? row.matter_number : "",
              ),
              "closed",
            ]);
          }
        }
        const reportCsv = toCsv(report);
        await db.query(
          "update core.matter_import set applied_at = now(), report = $2 where id = $1",
          [token, reportCsv],
        );
        await audit(db, p, client, "matter.imported", "matter_import", token, counts);
        return { applied: counts, report_csv: reportCsv };
      });
    },

    async importReport(p, token) {
      if (!UUID.test(token)) return null;
      return asApp(pool, p, async (db) => {
        const { rows } = await db.query<{ report: string | null }>(
          "select report from core.matter_import where id = $1",
          [token],
        );
        return rows[0]?.report ?? null;
      });
    },

    async walls(p, filters) {
      return attempt(p, async (db) => {
        await must(db, "admin.matters");
        const where = ["true"];
        const params: unknown[] = [];
        const add = (column: string, value: string | undefined) => {
          if (value === undefined) return;
          params.push(value);
          where.push(`${column} = $${params.length}`);
        };
        add("w.matter_id", filters.matterId);
        add("w.principal_id", filters.principalId);
        add("w.provider", filters.provider);
        return wallRows(db, where.join(" and "), params);
      });
    },

    async createWall(p, input, client) {
      return attempt(p, async (db) => {
        await must(db, "admin.matters");
        if (!(await findMatter(db, input.matter_id))) throw new Refused("NOT_FOUND");
        let id: string;
        try {
          await db.query("savepoint create_wall");
          const { rows } = await db.query<{ id: string }>(
            `insert into core.wall
               (workspace_id, matter_id, principal_type, principal_id, effect, provider, created_by)
             values ($1, $2, $3, $4, $5, 'internal', $6) returning id`,
            [
              p.workspaceId,
              input.matter_id,
              input.principal_type,
              input.principal_id,
              input.effect,
              p.userId,
            ],
          );
          id = rows[0]?.id as string;
          await db.query("release savepoint create_wall");
        } catch (err) {
          await db.query("rollback to savepoint create_wall");
          if (unique(err)) throw new Refused("WALL_EXISTS");
          if ((err as { code?: string }).code === "23503") throw new Refused("INVALID_PRINCIPAL");
          throw err;
        }
        await audit(db, p, client, "wall.created", "matter", input.matter_id, {
          matter_id: input.matter_id,
          principal_type: input.principal_type,
          principal_id: input.principal_id,
          effect: input.effect,
          provider: "internal",
        });
        const [row] = await wallRows(db, "w.id = $1", [id]);
        if (!row) throw new Error("new wall is not readable");
        return row;
      });
    },

    async removeWall(p, id, client) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      return attempt(p, async (db) => {
        await must(db, "admin.matters");
        const { rows } = await db.query<{
          matter_id: string;
          provider: string;
          principal_type: string;
          principal_id: string;
          effect: string;
        }>(
          "select matter_id, provider, principal_type, principal_id, effect from core.wall where id = $1",
          [id],
        );
        const wall = rows[0];
        if (!wall) throw new Refused("NOT_FOUND");
        // Synced rows belong to their provider; the next sync would only put them back.
        if (wall.provider !== "internal") throw new Refused("WALL_SYNCED");
        await db.query("delete from core.wall where id = $1", [id]);
        await audit(db, p, client, "wall.removed", "matter", wall.matter_id, {
          wall_id: id,
          ...wall,
        });
        return null;
      });
    },

    async principals(p, query) {
      return attempt(p, async (db) => {
        await must(db, "admin.matters");
        const { rows } = await db.query<{
          principal_type: "user" | "group";
          principal_id: string;
          label: string;
        }>("select * from core.wall_principals($1, '{}')", [query.replace(/[\\%_]/g, "\\$&")]);
        return rows.slice(0, 50);
      });
    },

    async wallImportPreview(p, csv, client) {
      return attempt(p, async (db) => {
        await must(db, "admin.matters");
        let table: ReturnType<typeof parseCsv>;
        try {
          table = parseCsv(csv, MATTER_LIMITS.importRows);
        } catch (err) {
          if (!(err instanceof CsvError)) throw err;
          throw new Refused(
            "INVALID_CSV",
            err.message === "TOO_MANY_ROWS" ? "The file is too long." : err.message,
          );
        }
        const keyed = table.header.includes("client_id") && table.header.includes("matter_number");
        const missing = WALL_COLUMNS.filter((c) => !table.header.includes(c));
        if (missing.length > 0 || !(keyed || table.header.includes("external_ref"))) {
          throw new Refused(
            "INVALID_CSV",
            "The header needs client_id and matter_number (or external_ref), principal_type, principal and effect.",
          );
        }
        if (table.records.length === 0) throw new Refused("INVALID_CSV", "The file has no rows.");
        const options = await readOptions(db);
        const matters = (await db.query<MatterRow>(MATTER_SQL)).rows;
        const byKey = new Map(matters.map((m) => [keyOf(m), m]));
        const byRef = new Map(
          matters.flatMap((m) => (m.external_ref ? [[m.external_ref, m]] : [])),
        );
        const unresolved: MatterImportIssue[] = [];
        const staged: StagedWall[] = [];
        const principalCache = new Map<string, string | null>();
        for (const record of table.records) {
          const r = records(table.header, record.values);
          const get = (name: string) => (r[name] ?? "").trim();
          const fail = (column: string, message: string) =>
            unresolved.push({ line: record.line, column, message });
          const matter =
            get("client_id") || get("matter_number")
              ? byKey.get(
                  keyOf({ client_id: get("client_id"), matter_number: get("matter_number") }),
                )
              : byRef.get(get("external_ref"));
          if (!matter) {
            fail("matter_number", "No matter has this client id and matter number.");
            continue;
          }
          const type = get("principal_type").toLowerCase();
          const effect = get("effect").toLowerCase();
          if (type !== "user" && type !== "group") {
            fail("principal_type", "principal_type must be user or group.");
            continue;
          }
          if (effect !== "allow" && effect !== "deny") {
            fail("effect", "effect must be allow or deny.");
            continue;
          }
          const name = get("principal");
          const cacheKey = `${type}\u0000${name.toLowerCase()}`;
          if (!principalCache.has(cacheKey)) {
            const { rows } = await db.query<{ id: string | null }>(
              "select core.find_wall_principal($1, $2) id",
              [type, name],
            );
            principalCache.set(cacheKey, rows[0]?.id ?? null);
          }
          const principalId = principalCache.get(cacheKey);
          if (!principalId) {
            fail(
              "principal",
              `No ${type} matches ${type === "user" ? "this email" : "this name"}.`,
            );
            continue;
          }
          staged.push({
            line: record.line,
            matter_id: matter.id,
            matter_display: matterDisplay(matter, options.display_format),
            principal_type: type,
            principal_id: principalId,
            principal: name,
            effect,
          });
        }
        const total = table.records.length;
        const accepted = unresolved.length <= total * MATTER_LIMITS.wallUnresolvedShare;
        const diff = await wallDiff(db, staged);
        const preview: WallCsvPreview = {
          token: null,
          accepted,
          matters: diff.matters,
          add: diff.add.slice(0, 500),
          remove: diff.remove.slice(0, 500),
          unchanged: diff.unchanged,
          rows: total,
          unresolved: unresolved.slice(0, MATTER_LIMITS.previewIssues),
        };
        if (accepted) {
          const { rows } = await db.query<{ id: string }>(
            `insert into core.matter_import (workspace_id, kind, mode, rows, preview, created_by)
             values ($1, 'walls', 'replace', $2, $3, $4) returning id`,
            [
              p.workspaceId,
              JSON.stringify(staged),
              JSON.stringify({ ...preview, add: diff.add.length, remove: diff.remove.length }),
              p.userId,
            ],
          );
          preview.token = rows[0]?.id ?? null;
        }
        void client;
        return preview;
      });
    },

    async wallImportApply(p, token, client) {
      if (!UUID.test(token)) return { ok: false, reason: "NOT_FOUND" };
      return attempt(p, async (db) => {
        await must(db, "admin.matters");
        const { rows } = await db.query<{
          rows: StagedWall[];
          expired: boolean;
          applied: boolean;
        }>(
          `select rows, expires_at < now() expired, applied_at is not null applied
             from core.matter_import where id = $1 and kind = 'walls' for update`,
          [token],
        );
        const job = rows[0];
        if (!job) throw new Refused("NOT_FOUND");
        if (job.expired || job.applied) throw new Refused("IMPORT_EXPIRED");
        const { rows: report } = await db.query<{ id: string }>(
          `insert into core.wall_sync_report (workspace_id, provider, status, created_by)
           values ($1, 'csv', 'running', $2) returning id`,
          [p.workspaceId, p.userId],
        );
        const diff = await wallDiff(db, job.rows);
        let added = 0;
        let removed = 0;
        for (const matterId of diff.matterIds) {
          const wanted = job.rows.filter((r) => r.matter_id === matterId);
          const { rowCount } = await db.query(
            `delete from core.wall w
              where w.matter_id = $1 and w.provider = 'csv'
                and not exists (select 1 from jsonb_to_recordset($2) as x(
                                  principal_type text, principal_id uuid, effect text)
                                 where x.principal_type = w.principal_type
                                   and x.principal_id = w.principal_id and x.effect = w.effect)`,
            [matterId, JSON.stringify(wanted)],
          );
          removed += rowCount ?? 0;
          const { rowCount: inserted } = await db.query(
            `insert into core.wall
               (workspace_id, matter_id, principal_type, principal_id, effect, provider, synced_at,
                created_by)
             select distinct $1::uuid, $2::uuid, x.principal_type, x.principal_id, x.effect, 'csv',
                    now(), $4::uuid
               from jsonb_to_recordset($3) as x(principal_type text, principal_id uuid, effect text)
             on conflict (matter_id, principal_type, principal_id, effect, provider) do nothing`,
            [p.workspaceId, matterId, JSON.stringify(wanted), p.userId],
          );
          added += inserted ?? 0;
        }
        const stats = { matters: diff.matterIds.length, rows_added: added, rows_removed: removed };
        await db.query(
          `update core.wall_sync_report set status = 'ok', finished_at = now(), stats = $2
            where id = $1`,
          [report[0]?.id, JSON.stringify(stats)],
        );
        await db.query("update core.matter_import set applied_at = now() where id = $1", [token]);
        await audit(db, p, client, "wall.csv_applied", "matter_import", token, {
          matters: diff.matterIds.length,
          add: added,
          remove: removed,
        });
        return { matters: diff.matterIds.length, add: added, remove: removed };
      });
    },

    async provider(p) {
      return attempt(p, async (db) => {
        if (!(await isAdmin(db)) && !(await can(db, "admin.config"))) {
          throw new Refused("FORBIDDEN");
        }
        return providerView(db);
      });
    },

    async setProvider(p, config, client) {
      return attempt(p, async (db) => {
        await must(db, "admin.config");
        if (!SUPPORTED_WALL_PROVIDERS.includes(config.kind)) {
          throw new Refused(
            "PROVIDER_NOT_SUPPORTED",
            `The ${config.kind} provider isn't available yet. Use internal or csv.`,
          );
        }
        await db.query(
          `insert into core.wall_provider
             (workspace_id, kind, config, cadence_minutes, secret_ref, updated_by)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (workspace_id) do update set
             kind = excluded.kind, config = excluded.config,
             cadence_minutes = excluded.cadence_minutes, secret_ref = excluded.secret_ref,
             updated_by = excluded.updated_by, updated_at = now()`,
          [
            p.workspaceId,
            config.kind,
            JSON.stringify(config.config),
            config.cadence_minutes,
            config.secret_ref,
            p.userId,
          ],
        );
        await audit(db, p, client, "wall.provider_configured", "workspace", p.workspaceId, {
          kind: config.kind,
        });
        return providerView(db);
      });
    },

    async syncs(p) {
      return attempt(p, async (db) => {
        await must(db, "admin.matters");
        const { rows } = await db.query<{
          id: string;
          provider: WallSyncReport["provider"];
          started_at: Date;
          finished_at: Date | null;
          status: WallSyncReport["status"];
          stats: { matters?: number; rows_added?: number; rows_removed?: number };
          unresolved: MatterImportIssue[];
        }>(
          `select id, provider, started_at, finished_at, status, stats, unresolved
             from core.wall_sync_report order by started_at desc limit 50`,
        );
        return rows.map((r) => ({
          id: r.id,
          provider: r.provider,
          started_at: r.started_at.toISOString(),
          finished_at: r.finished_at?.toISOString() ?? null,
          status: r.status,
          matters: r.stats.matters ?? 0,
          rows_added: r.stats.rows_added ?? 0,
          rows_removed: r.stats.rows_removed ?? 0,
          unresolved: r.unresolved,
        }));
      });
    },

    async evaluate(p, userId, matterId, client) {
      return attempt(p, async (db) => {
        await must(db, "admin.matters");
        const { rows } = await db.query<{ result: WallEvaluation | null }>(
          "select core.evaluate_wall($1, $2) result",
          [userId, matterId],
        );
        const result = rows[0]?.result;
        if (!result) throw new Refused("NOT_FOUND");
        await audit(db, p, client, "wall.evaluated", "matter", matterId, {
          user_id: userId,
          matter_id: matterId,
          allowed: result.allowed,
        });
        return result;
      });
    },
  };
}

/** What applying these rows would change: csv rows are replaced per matter in the file. */
async function wallDiff(db: Db, staged: StagedWall[]) {
  const matterIds = [...new Set(staged.map((s) => s.matter_id))];
  const key = (r: {
    matter_id: string;
    principal_type: string;
    principal_id: string;
    effect: string;
  }) => `${r.matter_id}|${r.principal_type}|${r.principal_id}|${r.effect}`;
  const { rows: current } = await db.query<{
    matter_id: string;
    principal_type: "user" | "group";
    principal_id: string;
    effect: "allow" | "deny";
  }>(
    `select matter_id, principal_type, principal_id, effect from core.wall
      where provider = 'csv' and matter_id = any ($1::uuid[])`,
    [matterIds],
  );
  const wanted = new Map(staged.map((s) => [key(s), s]));
  const have = new Set(current.map(key));
  const display = new Map(staged.map((s) => [s.matter_id, s.matter_display]));
  const add: WallCsvChange[] = [...wanted.entries()]
    .filter(([k]) => !have.has(k))
    .map(([, s]) => ({
      matter_display: s.matter_display,
      principal_type: s.principal_type,
      principal: s.principal,
      effect: s.effect,
    }));
  const gone = current.filter((r) => !wanted.has(key(r)));
  const { rows: names } = await db.query<{ principal_id: string; label: string }>(
    "select principal_id, label from core.wall_principals(null, $1::uuid[])",
    [gone.map((r) => r.principal_id)],
  );
  const label = new Map(names.map((n) => [n.principal_id, n.label]));
  const remove: WallCsvChange[] = gone.map((r) => ({
    matter_display: display.get(r.matter_id) ?? "",
    principal_type: r.principal_type,
    principal: label.get(r.principal_id) ?? r.principal_id,
    effect: r.effect,
  }));
  return {
    matterIds,
    matters: matterIds.length,
    add,
    remove,
    unchanged: wanted.size - add.length,
  };
}
