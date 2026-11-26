import {
  type AccessLevel,
  AGENT_LIMITS,
  type AgentAttachment,
  type AgentPatch,
  type AgentSource,
  type AgentVersionInput,
  type ApprovalConfig,
  approvalFor,
  DEFAULT_APPROVAL,
  diffList,
  diffWords,
  findRefs,
  levelRefusal,
  nextScheduledRun,
  type Schedule,
  type ShareRequestBody,
  scopeOf,
} from "@legallabs/contracts";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp } from "../db.js";
import type { Documents } from "../documents/documents.js";
import {
  type AttachmentPort,
  allAttachments,
  type Describer,
  noSources,
  noSpaces,
  type SchedulePort,
  type SourceCatalogue,
  type SpacePort,
} from "./ports.js";
import { type BundlePreview, readBundle, writeBundle } from "./skill.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Db = pg.PoolClient;

export type AgentFailure =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "AGENT_EMPTY_INSTRUCTIONS"
  | "AGENT_ATTACHMENT_LIMIT"
  | "AGENT_SOURCE_LIMIT"
  | "AGENT_LABEL_DUPLICATE"
  | "WALL_DENIED"
  | "WALL_SHARE_BLOCKED"
  | "SCHEDULE_REQUIRES_LIVE"
  | "LEVEL_REQUIRES_BUILD_PERMISSION"
  | "GUEST_RUN_ONLY"
  | "SPACE_INVITE_DENIED"
  | "SHARE_REQUEST_COOLDOWN"
  | "INVALID_PRINCIPAL"
  | "IMPORT_EXPIRED"
  | "NO_DRAFT"
  | "UPLOADS_UNAVAILABLE";

export type Result<T> = ({ ok: true } & T) | { ok: false; code: AgentFailure; detail?: unknown };
const fail = (
  code: AgentFailure,
  detail?: unknown,
): { ok: false; code: AgentFailure; detail?: unknown } =>
  detail === undefined ? { ok: false, code } : { ok: false, code, detail };

export interface AgentView {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  practice_areas: string[];
  status: "draft" | "live";
  live_version_id: string | null;
  draft_version_id: string | null;
  auto_description: boolean;
  my_access: AccessLevel;
  created_at: string;
  updated_at: string;
  stats: { runs: number; test_runs: number; last_run_at: string | null };
  schedule: ScheduleView | null;
}

export interface ScheduleView extends Schedule {
  status: "active" | "paused";
  paused_reason: string | null;
  next_run_at: string | null;
}

export interface VersionView {
  id: string;
  agent_id: string;
  no: number;
  instructions: string;
  attachments: AgentAttachment[];
  sources: AgentSource[];
  details: Record<string, unknown>;
  created_by: string;
  created_at: string;
}

export interface ListFilter {
  owner?: "me" | "shared" | "all";
  scheduled?: boolean;
  practice_area?: string;
  q?: string;
  limit?: number;
}

export interface AgentsDeps {
  attachments?: AttachmentPort;
  spaces?: SpacePort;
  scheduler?: SchedulePort;
  describer?: Describer;
  sources?: SourceCatalogue;
  documents?: Documents;
  now?: () => Date;
}

interface AgentRow {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  practice_areas: string[];
  live_version_id: string | null;
  draft_version_id: string | null;
  auto_description: boolean;
  created_at: Date;
  updated_at: Date;
  level: AccessLevel;
  runs: number;
  test_runs: number;
  last_run_at: Date | null;
}

const audit = (
  db: Db,
  principal: Principal,
  action: string,
  id: string | null,
  details: object,
  client: Client,
) =>
  db.query("select admin.append_audit_event($1, 'user', $2, 'agent', $3, $4, $5, $6)", [
    action,
    principal.userId,
    id,
    JSON.stringify(details),
    client.ip,
    uaHash(client),
  ]);

const SELECT_AGENT = `
  select a.id, a.owner_id, a.title, a.description, a.practice_areas, a.live_version_id,
         a.draft_version_id, a.auto_description, a.created_at, a.updated_at,
         work.agent_level(a.id) as level,
         (select count(*)::int from work.run r where r.subject_id = a.id and r.kind = 'agent'
             and not r.test_mode) as runs,
         (select count(*)::int from work.run r where r.subject_id = a.id and r.kind = 'agent'
             and r.test_mode) as test_runs,
         (select max(r.created_at) from work.run r where r.subject_id = a.id
             and r.kind = 'agent' and not r.test_mode) as last_run_at
    from work.agent a`;

const toView = (r: AgentRow, schedule: ScheduleView | null): AgentView => ({
  id: r.id,
  owner_id: r.owner_id,
  title: r.title,
  description: r.description,
  practice_areas: r.practice_areas,
  status: r.live_version_id ? "live" : "draft",
  live_version_id: r.live_version_id,
  draft_version_id: r.draft_version_id,
  auto_description: r.auto_description,
  my_access: r.level,
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
  stats: {
    runs: r.runs,
    test_runs: r.test_runs,
    last_run_at: r.last_run_at?.toISOString() ?? null,
  },
  schedule,
});

type ScheduleRow = {
  rule: "every_n_days" | "weekly";
  params: Schedule["params"];
  time_local: string;
  tz: string;
  matter_id: string | null;
  email: boolean;
  anchor_date: Date | null;
  status: "active" | "paused";
  paused_reason: string | null;
  next_run_at: Date | null;
};
const SCHEDULE_COLUMNS = `rule, params, time_local, tz, matter_id, email, anchor_date, status,
  paused_reason, next_run_at`;
const toSchedule = (r: ScheduleRow): ScheduleView => ({
  rule: r.rule,
  params: r.params,
  time_local: r.time_local,
  tz: r.tz,
  ...(r.matter_id ? { matter_id: r.matter_id } : {}),
  email: r.email,
  ...(r.anchor_date ? { anchor_date: r.anchor_date.toISOString().slice(0, 10) } : {}),
  status: r.status,
  paused_reason: r.paused_reason,
  next_run_at: r.next_run_at?.toISOString() ?? null,
});

const VERSION_COLUMNS =
  "id, agent_id, no, instructions, attachments, sources, details, created_by, created_at";
type VersionRow = Omit<VersionView, "created_at"> & { created_at: Date };
const toVersion = (r: VersionRow): VersionView => ({
  ...r,
  created_at: r.created_at.toISOString(),
});

export function createAgents(pool: pg.Pool, deps: AgentsDeps = {}) {
  const attachments = deps.attachments ?? allAttachments;
  const spaces = deps.spaces ?? noSpaces;
  /** An upload seen only through Run on someone's agent can't be taken into another. */
  const linkable = (principal: Principal, ref: string) =>
    asApp(pool, principal, async (db) => {
      const { rows } = await db.query<{ ok: boolean }>("select work.agent_upload_linkable($1) ok", [
        ref,
      ]);
      return rows[0]?.ok === true;
    });
  const sources = deps.sources ?? noSources;
  const now = deps.now ?? (() => new Date());
  const imports = new Map<string, { userId: string; preview: BundlePreview; expires: number }>();

  async function level(db: Db, id: string): Promise<AccessLevel | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await db.query<{ level: AccessLevel | null }>(
      "select work.agent_level($1) as level",
      [id],
    );
    return rows[0]?.level ?? null;
  }

  async function newVersion(
    db: Db,
    principal: Principal,
    agentId: string,
    content: { instructions: string; attachments: AgentAttachment[]; sources: AgentSource[] },
    details: Record<string, unknown>,
  ) {
    const { rows } = await db.query<{ id: string; no: number }>(
      `insert into work.agent_version (workspace_id, agent_id, no, instructions, attachments,
                                       sources, details, created_by)
       values ($1, $2, coalesce((select max(no) from work.agent_version where agent_id = $2), 0) + 1,
               $3, $4, $5, $6, $7)
       returning id, no`,
      [
        principal.workspaceId,
        agentId,
        content.instructions,
        JSON.stringify(content.attachments),
        JSON.stringify(content.sources),
        JSON.stringify(details),
        principal.userId,
      ],
    );
    return rows[0] as { id: string; no: number };
  }

  const agents = {
    async create(
      principal: Principal,
      body: { title?: string | undefined; mode: "describe" | "scratch" },
      client: Client,
    ): Promise<Result<{ agent: AgentView }>> {
      const allowed = await asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ ok: boolean }>(
          "select core.has_permission('agents.build') ok",
        );
        return rows[0]?.ok ?? false;
      });
      if (!allowed) return fail("FORBIDDEN");
      const id = await asApp(pool, principal, async (db) => {
        const { rows: a } = await db.query<{ id: string }>(
          `insert into work.agent (workspace_id, owner_id, title) values ($1, $2, $3) returning id`,
          [
            principal.workspaceId,
            principal.userId,
            (body.title?.trim() || "Untitled agent").slice(0, 120),
          ],
        );
        const agentId = a[0]?.id as string;
        const v = await newVersion(
          db,
          principal,
          agentId,
          { instructions: "", attachments: [], sources: [] },
          { title: body.title?.trim() || "Untitled agent", description: "", practice_areas: [] },
        );
        await db.query("update work.agent set draft_version_id = $2 where id = $1", [
          agentId,
          v.id,
        ]);
        await audit(db, principal, "agent.created", agentId, { mode: body.mode }, client);
        return agentId;
      });
      const got = await agents.get(principal, id);
      return got ?? fail("NOT_FOUND");
    },

    async get(principal: Principal, id: string): Promise<{ ok: true; agent: AgentView } | null> {
      if (!UUID.test(id)) return null;
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<AgentRow>(
          `${SELECT_AGENT} where a.id = $1 and a.deleted_at is null`,
          [id],
        );
        const row = rows[0];
        if (!row || !row.level) return null;
        const { rows: s } = await db.query<ScheduleRow>(
          `select ${SCHEDULE_COLUMNS} from work.agent_schedule where agent_id = $1 and user_id = $2`,
          [id, principal.userId],
        );
        return { ok: true as const, agent: toView(row, s[0] ? toSchedule(s[0]) : null) };
      });
    },

    list(principal: Principal, filter: ListFilter = {}): Promise<AgentView[]> {
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<AgentRow & { sched: ScheduleRow | null }>(
          `${SELECT_AGENT}
            where a.deleted_at is null and work.agent_level(a.id) is not null
              and ($1::text = 'all' or ($1 = 'me' and a.owner_id = $2) or ($1 = 'shared' and a.owner_id <> $2))
              and ($3::text is null or $3 = any (a.practice_areas))
              and ($4::text is null or a.title ilike '%' || $4 || '%' or a.description ilike '%' || $4 || '%')
              and (not $5 or exists (select 1 from work.agent_schedule s
                                      where s.agent_id = a.id and s.user_id = $2))
            order by a.updated_at desc, a.id desc limit $6`,
          [
            filter.owner ?? "all",
            principal.userId,
            filter.practice_area ?? null,
            filter.q ?? null,
            filter.scheduled ?? false,
            Math.min(filter.limit ?? 100, 200),
          ],
        );
        return rows.map((r) => toView(r, null));
      });
    },

    async patch(
      principal: Principal,
      id: string,
      patch: AgentPatch,
      client: Client,
    ): Promise<Result<{ agent: AgentView }>> {
      const ok = await asApp(pool, principal, async (db) => {
        const lvl = await level(db, id);
        if (!lvl) return "NOT_FOUND" as const;
        if (lvl === "run" || lvl === "view") return "FORBIDDEN" as const;
        await db.query(
          `update work.agent set title = coalesce($2, title), description = coalesce($3, description),
                  practice_areas = coalesce($4, practice_areas),
                  auto_description = coalesce($5, auto_description), updated_at = now()
            where id = $1`,
          [
            id,
            patch.title ?? null,
            patch.description ?? null,
            patch.practice_areas ?? null,
            patch.auto_description ?? null,
          ],
        );
        await audit(db, principal, "agent.updated", id, { fields: Object.keys(patch) }, client);
        return "ok" as const;
      });
      if (ok !== "ok") return fail(ok);
      return (await agents.get(principal, id)) ?? fail("NOT_FOUND");
    },

    async remove(principal: Principal, id: string, client: Client): Promise<Result<unknown>> {
      const result = await asApp(pool, principal, async (db) => {
        const lvl = await level(db, id);
        if (!lvl) return { code: "NOT_FOUND" as const };
        if (lvl !== "full") return { code: "FORBIDDEN" as const };
        const { rows } = await db.query<{ id: string }>(
          "select work.agent_schedule_ids($1) as id",
          [id],
        );
        await db.query("select work.agent_delete($1)", [id]);
        await audit(db, principal, "agent.deleted", id, {}, client);
        return { schedules: rows.map((r) => r.id) };
      });
      if ("code" in result) return fail(result.code);
      // Their Temporal schedules stop with it; the rows were paused by the database.
      for (const sid of result.schedules)
        await deps.scheduler?.pause(sid, "agent_deleted").catch(() => {});
      return { ok: true };
    },

    async duplicate(
      principal: Principal,
      id: string,
      client: Client,
    ): Promise<Result<{ agent: AgentView }>> {
      const made = await asApp(pool, principal, async (db) => {
        const lvl = await level(db, id);
        if (!lvl) return "NOT_FOUND" as const;
        if (lvl === "run") return "FORBIDDEN" as const;
        const { rows } = await db.query<{
          title: string;
          live_version_id: string | null;
          practice_areas: string[];
        }>("select title, live_version_id, practice_areas from work.agent where id = $1", [id]);
        const src = rows[0];
        if (!src?.live_version_id) return "NOT_FOUND" as const;
        const { rows: v } = await db.query<VersionRow>(
          `select ${VERSION_COLUMNS} from work.agent_version where id = $1`,
          [src.live_version_id],
        );
        const ver = v[0] as VersionRow;
        const { rows: a } = await db.query<{ id: string }>(
          `insert into work.agent (workspace_id, owner_id, title, practice_areas)
           values ($1, $2, $3, $4) returning id`,
          [
            principal.workspaceId,
            principal.userId,
            `${src.title} (copy)`.slice(0, 120),
            src.practice_areas,
          ],
        );
        const newId = a[0]?.id as string;
        const nv = await newVersion(db, principal, newId, ver, {
          ...ver.details,
          title: `${src.title} (copy)`,
        });
        await db.query("update work.agent set draft_version_id = $2 where id = $1", [newId, nv.id]);
        // Uploads stay the same documents; the copy reads them through its own link.
        await db.query(
          `insert into work.agent_document (workspace_id, agent_id, document_id)
           select workspace_id, $2, document_id from work.agent_document where agent_id = $1`,
          [id, newId],
        );
        await audit(db, principal, "agent.duplicated", newId, { from: id }, client);
        return newId;
      });
      if (made === "NOT_FOUND" || made === "FORBIDDEN") return fail(made);
      return (await agents.get(principal, made)) ?? fail("NOT_FOUND");
    },

    async versions(principal: Principal, id: string): Promise<VersionView[] | null> {
      return asApp(pool, principal, async (db) => {
        const lvl = await level(db, id);
        if (!lvl) return null;
        if (lvl === "run") return [];
        const { rows } = await db.query<VersionRow>(
          `select ${VERSION_COLUMNS} from work.agent_version where agent_id = $1 order by no desc`,
          [id],
        );
        return rows.map(toVersion);
      });
    },

    async saveVersion(
      principal: Principal,
      id: string,
      input: AgentVersionInput,
      client: Client,
      via: "edit" | "request_changes" = "edit",
    ): Promise<Result<{ version: VersionView; warnings: { code: string; label: string }[] }>> {
      if (input.attachments.length > AGENT_LIMITS.attachments)
        return fail("AGENT_ATTACHMENT_LIMIT");
      if (input.sources.length > AGENT_LIMITS.sources) return fail("AGENT_SOURCE_LIMIT");
      const labels = [...input.attachments, ...input.sources].map((x) => x.label.toLowerCase());
      if (new Set(labels).size !== labels.length) return fail("AGENT_LABEL_DUPLICATE");
      if (input.promote && input.instructions.trim().length === 0)
        return fail("AGENT_EMPTY_INSTRUCTIONS");

      // A walled or missing attachment is refused by id, never by the matter behind it.
      for (const a of input.attachments) {
        if (
          !(await attachments.available(principal, a)) ||
          (a.kind === "upload" && !(await linkable(principal, a.ref)))
        )
          return fail("WALL_DENIED", { attachment: a.label });
      }

      const known = [...input.attachments, ...input.sources].map((x) => x.label);
      const warnings = findRefs(input.instructions, known)
        .filter((r) => r.label === null)
        .map((r) => ({ code: "UNRESOLVED_LABEL", label: r.raw }));

      const description = await (async () => {
        if (!input.promote || !deps.describer) return null;
        const auto = await asApp(pool, principal, async (db) => {
          const { rows } = await db.query<{ auto_description: boolean; title: string }>(
            "select auto_description, title from work.agent where id = $1",
            [id],
          );
          return rows[0];
        });
        return auto?.auto_description
          ? await deps.describer.describe(principal, auto.title, input.instructions)
          : null;
      })();

      const saved = await asApp(pool, principal, async (db) => {
        const lvl = await level(db, id);
        if (!lvl) return "NOT_FOUND" as const;
        if (lvl === "run" || lvl === "view") return "FORBIDDEN" as const;
        if (description) {
          await db.query("update work.agent set description = $2 where id = $1", [
            id,
            description.slice(0, 1000),
          ]);
        }
        const { rows: a } = await db.query<{
          title: string;
          description: string;
          practice_areas: string[];
        }>("select title, description, practice_areas from work.agent where id = $1", [id]);
        const v = await newVersion(
          db,
          principal,
          id,
          {
            instructions: input.instructions,
            attachments: input.attachments,
            sources: input.sources,
          },
          {
            title: a[0]?.title,
            description: a[0]?.description,
            practice_areas: a[0]?.practice_areas,
          },
        );
        if (input.promote) {
          await db.query(
            "update work.agent set live_version_id = $2, draft_version_id = null, updated_at = now() where id = $1",
            [id, v.id],
          );
        } else {
          await db.query(
            "update work.agent set draft_version_id = $2, updated_at = now() where id = $1",
            [id, v.id],
          );
        }
        // Upload attachments are documents; link them so anyone who may run the agent can read them.
        // Links that stay are left in place: they are what entitles an editor to keep them.
        await db.query(
          "delete from work.agent_document where agent_id = $1 and not (document_id::text = any ($2))",
          [id, input.attachments.filter((x) => x.kind === "upload").map((x) => x.ref)],
        );
        for (const att of input.attachments.filter((x) => x.kind === "upload")) {
          await db.query(
            `insert into work.agent_document (workspace_id, agent_id, document_id)
             values ($1, $2, $3) on conflict do nothing`,
            [principal.workspaceId, id, att.ref],
          );
        }
        await audit(
          db,
          principal,
          "agent.version.saved",
          id,
          { version_no: v.no, promoted: input.promote },
          client,
        );
        if (!input.promote) await audit(db, principal, "agent.draft.updated", id, { via }, client);
        const { rows } = await db.query<VersionRow>(
          `select ${VERSION_COLUMNS} from work.agent_version where id = $1`,
          [v.id],
        );
        return toVersion(rows[0] as VersionRow);
      });
      if (saved === "NOT_FOUND" || saved === "FORBIDDEN") return fail(saved);
      return { ok: true, version: saved, warnings };
    },

    /** Changes from one version to another: a word redline plus what was added and dropped. */
    async diff(principal: Principal, id: string, a: string, b: string) {
      if (!UUID.test(a) || !UUID.test(b)) return null;
      return asApp(pool, principal, async (db) => {
        const lvl = await level(db, id);
        if (!lvl || lvl === "run") return null;
        const { rows } = await db.query<VersionRow>(
          `select ${VERSION_COLUMNS} from work.agent_version where agent_id = $1 and id = any ($2)`,
          [id, [a, b]],
        );
        const from = rows.find((r) => r.id === a);
        const to = rows.find((r) => r.id === b);
        if (!from || !to) return null;
        return {
          instructions_diff: diffWords(from.instructions, to.instructions),
          attachments: diffList(from.attachments, to.attachments, (x) => `${x.kind}:${x.ref}`),
          sources: diffList(from.sources, to.sources, (x) => `${x.kind}:${x.source}`),
        };
      });
    },

    async discardDraft(principal: Principal, id: string): Promise<Result<unknown>> {
      const r = await asApp(pool, principal, async (db) => {
        const lvl = await level(db, id);
        if (!lvl) return "NOT_FOUND" as const;
        if (lvl === "run" || lvl === "view") return "FORBIDDEN" as const;
        await db.query(
          "update work.agent set draft_version_id = null, updated_at = now() where id = $1",
          [id],
        );
        return "ok" as const;
      });
      return r === "ok" ? { ok: true } : fail(r);
    },

    // ---- sharing ----

    async shares(principal: Principal, id: string) {
      return asApp(pool, principal, async (db) => {
        const lvl = await level(db, id);
        if (lvl !== "full") return lvl ? ("FORBIDDEN" as const) : ("NOT_FOUND" as const);
        const { rows: grants } = await db.query("select * from work.agent_shares($1)", [id]);
        const { rows: requests } = await db.query(
          `select id, principal_type, principal_id, level, approver, status, requested_by, reason, created_at, decided_at
             from work.share_request where resource_type = 'agent' and resource_id = $1
            order by created_at desc limit 100`,
          [id],
        );
        return { grants, requests };
      });
    },

    async share(
      principal: Principal,
      id: string,
      body: ShareRequestBody,
      client: Client,
    ): Promise<Result<{ outcome: "granted" | "pending"; id: string }>> {
      return asApp(
        pool,
        principal,
        async (db): Promise<Result<{ outcome: "granted" | "pending"; id: string }>> => {
          const lvl = await level(db, id);
          if (!lvl) return fail("NOT_FOUND");
          if (lvl !== "full") return fail("FORBIDDEN");
          if (body.principal_type !== "workspace" && !body.principal_id)
            return fail("INVALID_PRINCIPAL");
          const principalId =
            body.principal_type === "workspace"
              ? principal.workspaceId
              : (body.principal_id as string);

          let external = false;
          let spaceAdmin = false;
          if (body.principal_type === "space") {
            const info = await spaces.info(principal, principalId);
            if (!info?.mayInvite) return fail("SPACE_INVITE_DENIED");
            external = info.external;
            spaceAdmin = info.requesterIsAdmin;
          }
          const scope = scopeOf(body.principal_type, external);
          let grantee = { build: true, guest: false };
          if (body.principal_type === "user") {
            const { rows } = await db.query<{ build: boolean; guest: boolean }>(
              `select work.user_can_build($1) as build,
                    coalesce((select u.kind = 'guest' from core."user" u where u.id = $1), false) as guest`,
              [principalId],
            );
            if (!rows[0]) return fail("INVALID_PRINCIPAL");
            grantee = rows[0];
          }
          const refusal = levelRefusal(body.level, grantee, scope);
          if (refusal) return fail(refusal);

          // Nobody walled from the matter of a file it carries may be given it (§4.6).
          if (body.principal_type !== "space") {
            const { rows } = await db.query<{ n: number }>(
              "select work.agent_grant_blocked($1, $2, $3) n",
              [id, body.principal_type, principalId],
            );
            if (rows[0]?.n) return fail("WALL_SHARE_BLOCKED");
          }

          const { rows: cfg } = await db.query<{
            require_individual: boolean;
            require_group: boolean;
            require_workspace: boolean;
          }>(
            "select require_individual, require_group, require_workspace from work.sharing_config where workspace_id = $1",
            [principal.workspaceId],
          );
          const config: ApprovalConfig = cfg[0]
            ? {
                individual: cfg[0].require_individual,
                group: cfg[0].require_group,
                workspace: cfg[0].require_workspace,
              }
            : DEFAULT_APPROVAL;
          const { rows: adm } = await db.query<{ a: boolean }>(
            "select core.has_permission('agents.admin') a",
          );
          const decision = approvalFor(config, scope, {
            agentsAdmin: adm[0]?.a ?? false,
            spaceAdmin,
          });

          if (!decision.required) {
            const { rows } = await db.query<{ g: string }>(
              "select work.agent_share($1, $2, $3, $4) g",
              [id, body.principal_type, principalId, body.level],
            );
            await audit(
              db,
              principal,
              "share.granted",
              id,
              { resource_type: "agent", principal: `${body.principal_type}`, level: body.level },
              client,
            );
            return { ok: true, outcome: "granted", id: rows[0]?.g as string };
          }

          const { rows: recent } = await db.query(
            `select 1 from work.share_request
            where resource_type = 'agent' and resource_id = $1 and principal_type = $2 and principal_id = $3
              and status = 'denied' and decided_at > $4::timestamptz - ($5 || ' days')::interval`,
            [
              id,
              body.principal_type,
              principalId,
              now().toISOString(),
              String(AGENT_LIMITS.cooldownDays),
            ],
          );
          if (recent.length > 0) return fail("SHARE_REQUEST_COOLDOWN");
          const { rows } = await db.query<{ id: string }>(
            `insert into work.share_request (workspace_id, resource_type, resource_id, principal_type,
                                           principal_id, level, approver, requested_by)
           values ($1, 'agent', $2, $3, $4, $5, $6, $7)
           on conflict (resource_type, resource_id, principal_type, principal_id) where status = 'pending'
             do nothing
           returning id`,
            [
              principal.workspaceId,
              id,
              body.principal_type,
              principalId,
              body.level,
              decision.approver,
              principal.userId,
            ],
          );
          await audit(
            db,
            principal,
            "share.requested",
            id,
            { resource_type: "agent", level: body.level, approver: decision.approver },
            client,
          );
          return { ok: true, outcome: "pending", id: rows[0]?.id as string };
        },
      );
    },

    async unshare(
      principal: Principal,
      id: string,
      grantId: string,
      client: Client,
    ): Promise<Result<unknown>> {
      if (!UUID.test(grantId)) return fail("NOT_FOUND");
      return asApp(pool, principal, async (db): Promise<Result<unknown>> => {
        const lvl = await level(db, id);
        if (!lvl) return fail("NOT_FOUND");
        if (lvl !== "full") return fail("FORBIDDEN");
        const { rows } = await db.query<{ r: boolean }>("select work.agent_unshare($1, $2) r", [
          id,
          grantId,
        ]);
        if (!rows[0]?.r) return fail("NOT_FOUND");
        await audit(db, principal, "share.revoked", id, { resource_type: "agent" }, client);
        return { ok: true };
      });
    },

    // ---- approvals queue ----

    async requests(principal: Principal, status: "pending" | "accepted" | "denied" = "pending") {
      return asApp(pool, principal, async (db) => {
        const { rows: adm } = await db.query<{ a: boolean }>(
          "select core.has_permission('agents.admin') a",
        );
        if (!adm[0]?.a) return null;
        const { rows } = await db.query(
          `select r.id, r.resource_type, r.resource_id, a.title, r.principal_type, r.principal_id, r.level,
                  r.approver, r.status, r.requested_by, r.created_at, r.reason
             from work.share_request r left join work.agent a on a.id = r.resource_id
            where r.status = $1 and r.approver = 'agents_admin' order by r.created_at limit 200`,
          [status],
        );
        return rows;
      });
    },

    async decide(
      principal: Principal,
      requestId: string,
      accept: boolean,
      reason: string | undefined,
      client: Client,
    ): Promise<"ok" | "NOT_FOUND" | "FORBIDDEN"> {
      if (!UUID.test(requestId)) return "NOT_FOUND";
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ r: string }>(
          "select work.decide_share_request($1, $2, $3) r",
          [requestId, accept, reason ?? null],
        );
        const r = rows[0]?.r;
        if (r !== "OK") return r === "FORBIDDEN" ? "FORBIDDEN" : "NOT_FOUND";
        await audit(
          db,
          principal,
          accept ? "share.accepted" : "share.denied",
          requestId,
          {},
          client,
        );
        return "ok";
      });
    },

    // ---- schedule ----

    async upsertSchedule(
      principal: Principal,
      id: string,
      schedule: Schedule,
      client: Client,
    ): Promise<Result<{ schedule: ScheduleView }>> {
      const anchor =
        schedule.anchor_date ??
        (schedule.rule === "every_n_days" ? now().toISOString().slice(0, 10) : undefined);
      const full: Schedule = anchor ? { ...schedule, anchor_date: anchor } : schedule;
      const next = nextScheduledRun(full, now());
      const row = await asApp(pool, principal, async (db) => {
        const lvl = await level(db, id);
        if (!lvl) return "NOT_FOUND" as const;
        const { rows: a } = await db.query<{ live: boolean }>(
          "select live_version_id is not null as live from work.agent where id = $1",
          [id],
        );
        if (!a[0]?.live) return "SCHEDULE_REQUIRES_LIVE" as const;
        const { rows: g } = await db.query<{ guest: boolean }>(
          `select coalesce((select u.kind = 'guest' from core."user" u where u.id = $1), false) as guest`,
          [principal.userId],
        );
        if (g[0]?.guest) return "FORBIDDEN" as const;
        const { rows } = await db.query<{ id: string }>(
          `insert into work.agent_schedule (workspace_id, agent_id, user_id, rule, params, time_local, tz,
                                            matter_id, email, anchor_date, status, paused_reason, next_run_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', null, $11)
           on conflict (agent_id, user_id) do update
             set rule = excluded.rule, params = excluded.params, time_local = excluded.time_local,
                 tz = excluded.tz, matter_id = excluded.matter_id, email = excluded.email,
                 anchor_date = excluded.anchor_date, status = 'active', paused_reason = null,
                 next_run_at = excluded.next_run_at, updated_at = now()
           returning id`,
          [
            principal.workspaceId,
            id,
            principal.userId,
            full.rule,
            JSON.stringify(full.params),
            full.time_local,
            full.tz,
            full.matter_id ?? null,
            full.email,
            full.anchor_date ?? null,
            next?.toISOString() ?? null,
          ],
        );
        await audit(db, principal, "agent.schedule.upserted", id, { rule: full.rule }, client);
        return rows[0]?.id as string;
      });
      if (row === "NOT_FOUND" || row === "SCHEDULE_REQUIRES_LIVE" || row === "FORBIDDEN")
        return fail(row);
      await deps.scheduler?.upsert(row, full);
      const got = await agents.get(principal, id);
      return got?.agent.schedule ? { ok: true, schedule: got.agent.schedule } : fail("NOT_FOUND");
    },

    async deleteSchedule(
      principal: Principal,
      id: string,
      client: Client,
    ): Promise<Result<unknown>> {
      const sid = await asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          "delete from work.agent_schedule where agent_id = $1 and user_id = $2 returning id",
          [id, principal.userId],
        );
        if (rows[0]) await audit(db, principal, "agent.schedule.deleted", id, {}, client);
        return rows[0]?.id;
      });
      if (!sid) return fail("NOT_FOUND");
      await deps.scheduler?.remove(sid);
      return { ok: true };
    },

    // ---- import and export ----

    async importPreview(principal: Principal, file: { name: string; bytes: Uint8Array }) {
      const catalogue = new Map<string, "ok" | "unknown_source" | "not_enabled">();
      const bundle = readBundle(file.bytes, file.name, {
        sourceStatus: (s) => catalogue.get(s) ?? "unknown_source",
        refResolves: () => false,
      });
      if (!bundle.ok) return bundle;
      // Source and reference checks need the database, so they run after the archive is read.
      for (const s of bundle.preview.sources) s.status = await sources.status(principal, s.source);
      for (const r of bundle.preview.refs) {
        r.resolved =
          (await attachments.available(principal, { kind: r.kind, ref: r.ref })) &&
          (r.kind !== "upload" || (await linkable(principal, r.ref)));
      }
      const token = crypto.randomUUID();
      const now1 = Date.now();
      for (const [t, v] of imports) if (v.expires < now1) imports.delete(t);
      imports.set(token, {
        userId: principal.userId,
        preview: bundle.preview,
        expires: now1 + 15 * 60_000,
      });
      const p = bundle.preview;
      return {
        ok: true as const,
        token,
        title: p.title,
        description: p.description,
        instructions: p.instructions,
        files: p.files.map((f) => ({
          label: f.label,
          name: f.name,
          size: f.bytes.byteLength,
          status: f.status,
        })),
        refs: p.refs.map(({ label, kind, name, resolved }) => ({ label, kind, name, resolved })),
        sources: p.sources.map(({ label, source, status }) => ({ label, source, status })),
        issues: p.issues,
      };
    },

    async confirmImport(
      principal: Principal,
      token: string,
      body: { title?: string | undefined; drop_labels: string[] },
      client: Client,
    ): Promise<Result<{ agent: AgentView }>> {
      const held = imports.get(token);
      if (!held || held.userId !== principal.userId || held.expires < Date.now())
        return fail("IMPORT_EXPIRED");
      imports.delete(token);
      const p = held.preview;
      const drop = new Set(body.drop_labels);
      const attachmentsOut: AgentAttachment[] = [];
      let dropped = 0;
      for (const f of p.files) {
        if (f.status !== "ok" || drop.has(f.label)) {
          dropped += 1;
          continue;
        }
        if (!deps.documents) return fail("UPLOADS_UNAVAILABLE");
        const up = await deps.documents.upload(
          principal,
          { name: f.name, bytes: f.bytes, matterId: null },
          client,
        );
        if (!up.ok) {
          dropped += 1;
          continue;
        }
        attachmentsOut.push({ label: f.label, kind: "upload", ref: up.document.id, name: f.name });
      }
      for (const r of p.refs) {
        if (r.resolved && !drop.has(r.label))
          attachmentsOut.push({ label: r.label, kind: r.kind, ref: r.ref, name: r.name });
        else dropped += 1;
      }
      // Sources the workspace doesn't have are dropped here, not carried along disabled.
      const sourcesOut: AgentSource[] = [];
      for (const s of p.sources) {
        if (s.status === "ok" && !drop.has(s.label)) {
          sourcesOut.push({
            label: s.label,
            kind: s.kind,
            source: s.source,
            ...(s.filters ? { filters: s.filters } : {}),
          });
        } else dropped += 1;
      }
      const title = (body.title ?? p.title).slice(0, 120);
      const id = await asApp(pool, principal, async (db) => {
        const { rows: a } = await db.query<{ id: string }>(
          `insert into work.agent (workspace_id, owner_id, title, description, practice_areas)
           values ($1, $2, $3, $4, $5) returning id`,
          [principal.workspaceId, principal.userId, title, p.description, p.practice_areas],
        );
        const agentId = a[0]?.id as string;
        const v = await newVersion(
          db,
          principal,
          agentId,
          { instructions: p.instructions, attachments: attachmentsOut, sources: sourcesOut },
          {
            title,
            description: p.description,
            practice_areas: p.practice_areas,
          },
        );
        await db.query("update work.agent set draft_version_id = $2 where id = $1", [
          agentId,
          v.id,
        ]);
        for (const att of attachmentsOut.filter((x) => x.kind === "upload")) {
          await db.query(
            "insert into work.agent_document (workspace_id, agent_id, document_id) values ($1, $2, $3)",
            [principal.workspaceId, agentId, att.ref],
          );
        }
        await audit(
          db,
          principal,
          "agent.imported",
          agentId,
          {
            files: p.files.length,
            dropped_sources: p.sources.filter((s) => s.status !== "ok").length,
            dropped,
          },
          client,
        );
        return agentId;
      });
      return (await agents.get(principal, id)) ?? fail("NOT_FOUND");
    },

    async export(principal: Principal, id: string, client: Client): Promise<Uint8Array | null> {
      const data = await asApp(pool, principal, async (db) => {
        const lvl = await level(db, id);
        if (!lvl || lvl === "run") return null;
        const { rows } = await db.query<{
          title: string;
          description: string;
          practice_areas: string[];
          live_version_id: string | null;
        }>(
          "select title, description, practice_areas, live_version_id from work.agent where id = $1",
          [id],
        );
        const a = rows[0];
        if (!a?.live_version_id) return null;
        const { rows: v } = await db.query<VersionRow>(
          `select ${VERSION_COLUMNS} from work.agent_version where id = $1`,
          [a.live_version_id],
        );
        await audit(db, principal, "agent.exported", id, {}, client);
        return { a, v: v[0] as VersionRow };
      });
      if (!data) return null;
      const uploads = new Map<string, { name: string; bytes: Uint8Array }>();
      // Uploads go in the bundle when the documents module can read their bytes back.
      return writeBundle({
        title: data.a.title,
        description: data.a.description,
        practice_areas: data.a.practice_areas,
        instructions: data.v.instructions,
        attachments: data.v.attachments,
        sources: data.v.sources,
        uploads,
        origin: { exported_from: "legallabs", agent_id: id, version: data.v.no },
      });
    },
  };
  return agents;
}

export type Agents = ReturnType<typeof createAgents>;
