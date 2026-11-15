import { randomBytes } from "node:crypto";
import {
  PLAYBOOK_LIMITS,
  type Playbook,
  type PlaybookCreate,
  type PlaybookGrant,
  type PlaybookLevel,
  type PlaybookPatch,
  type PlaybookSummary,
  type PlaybookVersion,
  type Rule,
  starterPlaybook,
} from "@legallabs/contracts";
import type { Gateway } from "@legallabs/model-gateway";
import type pg from "pg";
import type { z } from "zod";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp, RLS_REFUSED } from "../db.js";
import {
  type GeneratedRule,
  GenerateError,
  generateRules,
  type Page,
  type RuleDraft,
} from "./generate.js";

type CreateInput = z.output<typeof PlaybookCreate>;
type PatchInput = z.output<typeof PlaybookPatch>;
type StoredRule = Rule;

export type PlaybookFailure =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "RULE_LIMIT"
  | "INVALID_PRINCIPAL"
  | "NO_PARSEABLE_INPUT"
  | "DOC_TOO_LARGE"
  | "NO_RULES_FOUND"
  | "MODEL_UNAVAILABLE";

export type PlaybookResult =
  | { ok: true; playbook: Playbook; generation?: { parts_read: number; parts_total: number } }
  | { ok: false; reason: PlaybookFailure };

export interface ListFilter {
  status?: "published" | "unpublished" | undefined;
  contract_type?: string | undefined;
  q?: string | undefined;
}

export interface Playbooks {
  list(principal: Principal, filter: ListFilter): Promise<PlaybookSummary[]>;
  get(principal: Principal, id: string): Promise<Playbook | null>;
  create(principal: Principal, input: CreateInput, client: Client): Promise<PlaybookResult>;
  /** Every saved change is a new version, so a review always names what it ran against. */
  update(
    principal: Principal,
    id: string,
    patch: PatchInput,
    client: Client,
  ): Promise<PlaybookResult>;
  setStatus(
    principal: Principal,
    id: string,
    status: "published" | "unpublished",
    client: Client,
  ): Promise<PlaybookResult>;
  remove(
    principal: Principal,
    id: string,
    client: Client,
  ): Promise<{ ok: true } | { ok: false; reason: PlaybookFailure }>;
  versions(principal: Principal, id: string): Promise<PlaybookVersion[] | null>;
  /** A past version, shaped like the playbook as it was then. */
  version(principal: Principal, id: string, no: number): Promise<Playbook | null>;
  grants(principal: Principal, id: string): Promise<PlaybookGrant[] | null>;
  setGrants(
    principal: Principal,
    id: string,
    grants: readonly PlaybookGrant[],
    client: Client,
  ): Promise<{ ok: true; grants: PlaybookGrant[] } | { ok: false; reason: PlaybookFailure }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_LIMIT = 200;

/** Version 7: time first, so rule ids sort in the order they were made. */
export function uuid7(now = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

class Refused extends Error {
  constructor(readonly reason: PlaybookFailure) {
    super(reason);
  }
}

type Db = pg.PoolClient;
type In = RuleDraft & { provenance?: GeneratedRule["provenance"] | undefined };

const isRefusal = (err: unknown) => (err as { code?: string }).code === RLS_REFUSED;
const isBadPrincipal = (err: unknown) => (err as { code?: string }).code === "23503";

/**
 * Ids the playbook already had are kept so findings and conditions still point at them;
 * anything else gets a new one, and conditions follow the rename. Provenance is carried over
 * from the stored rule, since clients can't claim it.
 */
export function assignIds(rules: readonly In[], previous: readonly StoredRule[]): StoredRule[] {
  const known = new Map(previous.map((r) => [r.id, r]));
  const renamed = new Map<string, string>();
  const ids = rules.map((r) => {
    if (r.id && known.has(r.id)) return r.id;
    const fresh = uuid7();
    if (r.id) renamed.set(r.id, fresh);
    return fresh;
  });
  return rules.map((r, ordinal) => {
    const id = ids[ordinal] ?? uuid7();
    const condition =
      r.condition?.kind === "rule_status" && renamed.has(r.condition.rule_id)
        ? { ...r.condition, rule_id: renamed.get(r.condition.rule_id) ?? r.condition.rule_id }
        : r.condition;
    const provenance = r.provenance !== undefined ? r.provenance : known.get(id)?.provenance;
    const { provenance: _drop, ...rest } = r;
    return {
      ...rest,
      id,
      ordinal,
      ...(condition ? { condition } : {}),
      ...(provenance !== undefined ? { provenance } : {}),
    } as StoredRule;
  });
}

/** Copies for a clone: every id is new, and conditions follow. */
const fresh = (rules: readonly StoredRule[]): StoredRule[] =>
  assignIds(
    rules.map(({ ordinal: _o, ...r }) => r),
    [],
  );

interface Row {
  id: string;
  workspace_id: string;
  owner_id: string;
  name: string;
  contract_type: string;
  status: "published" | "unpublished";
  version_id: string;
  version_no: number;
  guidance: string | null;
  rule_count: number;
  access: PlaybookLevel;
  created_at: Date;
  updated_at: Date;
}

const select = (extra = "") => `
  select${extra} p.id, p.workspace_id, p.owner_id, p.name, p.contract_type, p.status, p.version_id,
         v.no version_no, v.guidance, jsonb_array_length(v.rules) rule_count,
         work.playbook_level(p.id) access, p.created_at, p.updated_at
    from work.playbook p
    join work.playbook_version v on v.id = p.version_id`;

const summary = (row: Row): PlaybookSummary => ({
  id: row.id,
  workspace_id: row.workspace_id,
  owner_id: row.owner_id,
  name: row.name,
  contract_type: row.contract_type,
  guidance: row.guidance,
  status: row.status,
  version_id: row.version_id,
  version_no: row.version_no,
  access: row.access,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
  rule_count: row.rule_count,
});

async function load(db: Db, id: string): Promise<Playbook | null> {
  const { rows } = await db.query<Row & { rules: StoredRule[] }>(
    `${select(" v.rules,")} where p.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const { rule_count: _c, ...rest } = summary(row);
  return { ...rest, rules: row.rules };
}

const audit = (
  db: Db,
  principal: Principal,
  action: string,
  id: string,
  details: object,
  client: Client,
) =>
  db.query("select admin.append_audit_event($1, 'user', $2, 'playbook', $3, $4, $5, $6)", [
    action,
    principal.userId,
    id,
    JSON.stringify(details),
    client.ip,
    uaHash(client),
  ]);

async function addVersion(
  db: Db,
  principal: Principal,
  id: string,
  content: { name: string; contract_type: string; guidance: string | null; rules: StoredRule[] },
): Promise<{ versionId: string; no: number }> {
  if (content.rules.length > PLAYBOOK_LIMITS.rules) throw new Refused("RULE_LIMIT");
  const { rows } = await db.query<{ id: string; no: number }>(
    `insert into work.playbook_version
       (workspace_id, playbook_id, no, name, contract_type, guidance, rules, created_by)
     select $1, $2, coalesce(max(no), 0) + 1, $3, $4, $5, $6, $7
       from work.playbook_version where playbook_id = $2
     returning id, no`,
    [
      principal.workspaceId,
      id,
      content.name,
      content.contract_type,
      content.guidance,
      JSON.stringify(content.rules),
      principal.userId,
    ],
  );
  const row = rows[0];
  if (!row) throw new Refused("NOT_FOUND");
  return { versionId: row.id, no: row.no };
}

async function documentPages(
  db: Db,
  documentId: string,
): Promise<{ pages: Page[]; chars: number } | null> {
  const { rows: version } = await db.query<{ id: string; status: string | null }>(
    `select v.id, j.status
       from content.document d
       join content.document_version v on v.document_id = d.id
       left join content.ingest_job j on j.version_id = v.id
      where d.id = $1 and core.has_permission('threads.use')
      order by v.created_at desc limit 1`,
    [documentId],
  );
  const found = version[0];
  if (!found) return null;
  if (found.status !== null && found.status !== "indexed") return { pages: [], chars: 0 };
  const { rows } = await db.query<{ page_no: number; text: string; chars: number }>(
    `select page_no, text, char_length(text) chars from content.page
      where version_id = $1 and text <> '' order by page_no`,
    [found.id],
  );
  return { pages: rows, chars: rows.reduce((t, r) => t + r.chars, 0) };
}

export function createPlaybooks(pool: pg.Pool, { gateway }: { gateway: Gateway }): Playbooks {
  async function guarded<T>(
    principal: Principal,
    work: (db: Db) => Promise<T>,
  ): Promise<T | { ok: false; reason: PlaybookFailure }> {
    try {
      return await asApp(pool, principal, work);
    } catch (err) {
      if (err instanceof Refused) return { ok: false, reason: err.reason };
      if (isRefusal(err)) return { ok: false, reason: "FORBIDDEN" };
      if (isBadPrincipal(err)) return { ok: false, reason: "INVALID_PRINCIPAL" };
      throw err;
    }
  }

  // Locked per playbook, so two saves never race for one version number.
  const lockedLevel = async (db: Db, id: string) => {
    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [id]);
    const { rows } = await db.query<{ level: PlaybookLevel | null }>(
      "select work.playbook_level($1) as level",
      [id],
    );
    const level = rows[0]?.level ?? null;
    if (!level) throw new Refused("NOT_FOUND");
    return level;
  };

  async function sourceRules(
    principal: Principal,
    input: CreateInput,
  ): Promise<{
    rules: In[];
    guidance?: string;
    generation?: { parts_read: number; parts_total: number };
  }> {
    const source = input.source;
    switch (source.kind) {
      case "scratch":
        return { rules: source.rules };
      case "starter": {
        const starter = starterPlaybook(source.template);
        return { rules: starter.rules as In[], guidance: starter.guidance };
      }
      case "playbook": {
        const from = await asApp(pool, principal, (db) => load(db, source.playbook_id));
        if (!from) throw new Refused("NOT_FOUND");
        return { rules: fresh(from.rules), ...(from.guidance ? { guidance: from.guidance } : {}) };
      }
      case "document": {
        const doc = await asApp(pool, principal, (db) => documentPages(db, source.document_id));
        if (!doc) throw new Refused("NOT_FOUND");
        if (doc.chars > PLAYBOOK_LIMITS.doc_chars) throw new Refused("DOC_TOO_LARGE");
        if (doc.pages.length === 0) throw new Refused("NO_PARSEABLE_INPUT");
        try {
          const generated = await generateRules(gateway, {
            workspaceId: principal.workspaceId,
            documentId: source.document_id,
            contractType: input.contract_type,
            pages: doc.pages,
          });
          return {
            rules: generated.rules,
            generation: { parts_read: generated.parts_read, parts_total: generated.parts_total },
          };
        } catch (err) {
          if (err instanceof GenerateError) throw new Refused(err.reason);
          throw err;
        }
      }
    }
  }

  return {
    async list(principal, filter) {
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<Row>(
          `${select()}
            where ($1::text is null or p.status = $1)
              and ($2::text is null or lower(p.contract_type) = lower($2))
              and ($3::text is null or p.name ilike '%' || $3 || '%' or p.contract_type ilike '%' || $3 || '%')
            order by p.updated_at desc, p.id desc limit $4`,
          [
            filter.status ?? null,
            filter.contract_type ?? null,
            filter.q ? filter.q.replace(/[\\%_]/g, (c) => `\\${c}`) : null,
            LIST_LIMIT,
          ],
        );
        return rows.map(summary);
      });
    },

    async get(principal, id) {
      if (!UUID.test(id)) return null;
      return asApp(pool, principal, (db) => load(db, id));
    },

    async create(principal, input, client) {
      try {
        const source = await sourceRules(principal, input);
        const rules = assignIds(source.rules, []);
        const guidance = input.guidance ?? source.guidance ?? null;
        return await guarded(principal, async (db) => {
          const id = uuid7();
          const versionId = uuid7();
          // The version check is deferred to commit, so the row can name it before it exists.
          await db.query(
            `insert into work.playbook (id, workspace_id, owner_id, name, contract_type, version_id)
             values ($1, $2, $3, $4, $5, $6)`,
            [
              id,
              principal.workspaceId,
              principal.userId,
              input.name,
              input.contract_type,
              versionId,
            ],
          );
          await db.query(
            `insert into work.playbook_version
               (id, workspace_id, playbook_id, no, name, contract_type, guidance, rules, created_by)
             values ($1, $2, $3, 1, $4, $5, $6, $7, $8)`,
            [
              versionId,
              principal.workspaceId,
              id,
              input.name,
              input.contract_type,
              guidance,
              JSON.stringify(rules),
              principal.userId,
            ],
          );
          // Counts and kinds only: clause text never goes in the audit trail.
          await audit(
            db,
            principal,
            "playbook.created",
            id,
            { source: input.source.kind, version_no: 1, rule_count: rules.length },
            client,
          );
          if (input.source.kind === "document") {
            await audit(
              db,
              principal,
              "playbook.generated",
              id,
              {
                source_kind: "document",
                input_count: 1,
                rule_count: rules.length,
                verified_count: rules.filter((r) => r.provenance?.verified).length,
              },
              client,
            );
          }
          const playbook = await load(db, id);
          if (!playbook) throw new Refused("NOT_FOUND");
          return {
            ok: true,
            playbook,
            ...(source.generation ? { generation: source.generation } : {}),
          } as const;
        });
      } catch (err) {
        if (err instanceof Refused) return { ok: false, reason: err.reason };
        if (isRefusal(err)) return { ok: false, reason: "FORBIDDEN" };
        throw err;
      }
    },

    async update(principal, id, patch, client) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      return guarded(principal, async (db) => {
        const level = await lockedLevel(db, id);
        if (level === "view") throw new Refused("FORBIDDEN");
        const current = await load(db, id);
        if (!current) throw new Refused("NOT_FOUND");
        const rules = patch.rules ? assignIds(patch.rules, current.rules) : current.rules;
        const next = {
          name: patch.name ?? current.name,
          contract_type: patch.contract_type ?? current.contract_type,
          guidance: patch.guidance !== undefined ? patch.guidance : current.guidance,
          rules,
        };
        const { versionId, no } = await addVersion(db, principal, id, next);
        await db.query(
          `update work.playbook set name = $2, contract_type = $3, version_id = $4,
                  updated_at = now() where id = $1`,
          [id, next.name, next.contract_type, versionId],
        );
        const before = new Map(current.rules.map((r) => [r.id, JSON.stringify(r)]));
        const changed = rules
          .filter((r) => before.get(r.id) !== JSON.stringify(r))
          .map((r) => r.id);
        const removed = current.rules
          .filter((r) => !rules.some((n) => n.id === r.id))
          .map((r) => r.id);
        await audit(
          db,
          principal,
          "playbook.updated",
          id,
          { version_no: no, changed_rule_ids: changed, removed_rule_ids: removed },
          client,
        );
        const playbook = await load(db, id);
        if (!playbook) throw new Refused("NOT_FOUND");
        return { ok: true, playbook } as const;
      });
    },

    async setStatus(principal, id, status, client) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      return guarded(principal, async (db) => {
        const level = await lockedLevel(db, id);
        if (level !== "manage") throw new Refused("FORBIDDEN");
        const { rowCount } = await db.query(
          "update work.playbook set status = $2, updated_at = now() where id = $1 and status <> $2",
          [id, status],
        );
        const playbook = await load(db, id);
        if (!playbook) throw new Refused("NOT_FOUND");
        if (rowCount) {
          await audit(
            db,
            principal,
            status === "published" ? "playbook.published" : "playbook.unpublished",
            id,
            { version_no: playbook.version_no },
            client,
          );
        }
        return { ok: true, playbook } as const;
      });
    },

    async remove(principal, id, client) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      return guarded(principal, async (db) => {
        const level = await lockedLevel(db, id);
        if (level !== "manage") throw new Refused("FORBIDDEN");
        await db.query("select work.delete_playbook($1)", [id]);
        await audit(db, principal, "playbook.deleted", id, {}, client);
        return { ok: true } as const;
      });
    },

    async versions(principal, id) {
      if (!UUID.test(id)) return null;
      return asApp(pool, principal, async (db) => {
        const visible = await db.query("select 1 from work.playbook where id = $1", [id]);
        if (visible.rowCount === 0) return null;
        const { rows } = await db.query<{
          id: string;
          no: number;
          created_by: string;
          created_at: Date;
          rule_count: number;
        }>(
          `select id, no, created_by, created_at, jsonb_array_length(rules) rule_count
             from work.playbook_version where playbook_id = $1 order by no desc`,
          [id],
        );
        return rows.map((r) => ({
          version_id: r.id,
          no: r.no,
          created_by: r.created_by,
          created_at: r.created_at.toISOString(),
          rule_count: r.rule_count,
        }));
      });
    },

    async version(principal, id, no) {
      if (!UUID.test(id)) return null;
      return asApp(pool, principal, async (db) => {
        const current = await load(db, id);
        if (!current) return null;
        const { rows } = await db.query<{
          id: string;
          no: number;
          name: string;
          contract_type: string;
          guidance: string | null;
          rules: StoredRule[];
          created_at: Date;
        }>(
          `select id, no, name, contract_type, guidance, rules, created_at
             from work.playbook_version where playbook_id = $1 and no = $2`,
          [id, no],
        );
        const v = rows[0];
        if (!v) return null;
        return {
          ...current,
          name: v.name,
          contract_type: v.contract_type,
          guidance: v.guidance,
          version_id: v.id,
          version_no: v.no,
          rules: v.rules,
          updated_at: v.created_at.toISOString(),
        };
      });
    },

    async grants(principal, id) {
      if (!UUID.test(id)) return null;
      return asApp(pool, principal, async (db) => {
        const visible = await db.query("select 1 from work.playbook where id = $1", [id]);
        if (visible.rowCount === 0) return null;
        const { rows } = await db.query<PlaybookGrant>(
          `select principal_type, principal_id, level from work.playbook_grant
            where playbook_id = $1 order by granted_at, principal_id`,
          [id],
        );
        return rows;
      });
    },

    async setGrants(principal, id, grants, client) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      return guarded(principal, async (db) => {
        const level = await lockedLevel(db, id);
        if (level !== "manage") throw new Refused("FORBIDDEN");
        // One level per principal: the last one given wins.
        const unique = new Map(grants.map((g) => [`${g.principal_type}:${g.principal_id}`, g]));
        await db.query("delete from work.playbook_grant where playbook_id = $1", [id]);
        for (const g of unique.values()) {
          await db.query(
            `insert into work.playbook_grant
               (workspace_id, playbook_id, principal_type, principal_id, level, granted_by)
             values ($1, $2, $3, $4, $5, $6)`,
            [
              principal.workspaceId,
              id,
              g.principal_type,
              g.principal_id,
              g.level,
              principal.userId,
            ],
          );
        }
        const counts = { view: 0, edit: 0, manage: 0 };
        for (const g of unique.values()) counts[g.level] += 1;
        await audit(db, principal, "playbook.grant_changed", id, counts, client);
        return { ok: true, grants: [...unique.values()] } as const;
      });
    },
  };
}
