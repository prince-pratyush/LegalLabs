import { verifyCitation } from "@legallabs/citations";
import {
  type EntityCreate,
  type EntityPatch,
  FACT_LIMITS,
  type Fact,
  type FactAuditEntry,
  type FactCitationInput,
  type FactCreate,
  type FactEntity,
  type FactFile,
  type FactIssue,
  type FactPatch,
  type FactStatus,
  type FactVersion,
  type FactWhen,
  factWhenProblem,
  type IssueCreate,
  type IssuePatch,
} from "@legallabs/contracts";
import type pg from "pg";
import type { z } from "zod";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { storable } from "../connectors/sanitise.js";
import { asApp, RLS_REFUSED } from "../db.js";

// A Space's fact table. Row-level security decides what is seen: a fact is there only for a
// Space member who can open every document it cites.

export type Db = pg.PoolClient;

export type FactFailure =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID"
  | "DOCUMENT_NOT_FOUND"
  | "QUOTE_NOT_FOUND"
  | "UNKNOWN_ENTITY"
  | "UNKNOWN_ISSUE"
  | "TOO_MANY_DOCUMENTS"
  | "TOO_MANY_RUNS"
  | "TOO_MANY_REQUESTS"
  | "BAD_CURSOR";

export type FactResult<T> = { ok: true; value: T } | { ok: false; reason: FactFailure };

export interface FactFilter {
  entityId?: string | undefined;
  issueId?: string | undefined;
  documentId?: string | undefined;
  status?: FactStatus | undefined;
  /** Facts whose dates touch this range, inclusive. */
  from?: string | undefined;
  to?: string | undefined;
  cursor?: string | undefined;
}

export interface FactPage {
  facts: Fact[];
  next_cursor: string | null;
}

export interface Facts {
  files(
    p: Principal,
    spaceId: string,
  ): Promise<FactResult<{ files: FactFile[]; truncated: boolean }>>;
  list(p: Principal, spaceId: string, filter: FactFilter): Promise<FactResult<FactPage>>;
  get(p: Principal, spaceId: string, id: string): Promise<FactResult<Fact>>;
  create(
    p: Principal,
    spaceId: string,
    input: z.output<typeof FactCreate>,
    client: Client,
  ): Promise<FactResult<Fact>>;
  patch(
    p: Principal,
    spaceId: string,
    id: string,
    patch: z.output<typeof FactPatch>,
    client: Client,
  ): Promise<FactResult<Fact>>;
  setStatus(
    p: Principal,
    spaceId: string,
    id: string,
    status: FactStatus,
    client: Client,
  ): Promise<FactResult<Fact>>;
  versions(p: Principal, spaceId: string, id: string): Promise<FactResult<FactVersion[]>>;
  entities(p: Principal, spaceId: string): Promise<FactResult<FactEntity[]>>;
  createEntity(
    p: Principal,
    spaceId: string,
    input: z.output<typeof EntityCreate>,
    client: Client,
  ): Promise<FactResult<FactEntity>>;
  patchEntity(
    p: Principal,
    spaceId: string,
    id: string,
    patch: z.output<typeof EntityPatch>,
    client: Client,
  ): Promise<FactResult<FactEntity>>;
  issues(p: Principal, spaceId: string): Promise<FactResult<FactIssue[]>>;
  createIssue(
    p: Principal,
    spaceId: string,
    input: z.output<typeof IssueCreate>,
    client: Client,
  ): Promise<FactResult<FactIssue>>;
  patchIssue(
    p: Principal,
    spaceId: string,
    id: string,
    patch: z.output<typeof IssuePatch>,
    client: Client,
  ): Promise<FactResult<FactIssue>>;
  audit(
    p: Principal,
    spaceId: string,
    cursor?: string,
  ): Promise<FactResult<{ entries: FactAuditEntry[]; next_cursor: string | null }>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^(\d{4}-\d\d-\d\d)\|([0-9a-f-]{36})$/;

export class FactRefused extends Error {
  constructor(readonly reason: FactFailure) {
    super(reason);
  }
}
const refuse = (reason: FactFailure): never => {
  throw new FactRefused(reason);
};

/** Runs `work` as the caller, once the Space's fact table is theirs to work in. */
export async function inFactSpace<T>(
  pool: pg.Pool,
  p: Principal,
  spaceId: string,
  work: (db: Db) => Promise<T>,
): Promise<FactResult<T>> {
  if (!UUID.test(spaceId)) return { ok: false, reason: "NOT_FOUND" };
  try {
    const value = await asApp(pool, p, async (db) => {
      const { rowCount } = await db.query("select 1 where $1 = any (apps.fact_spaces())", [
        spaceId,
      ]);
      if (!rowCount) refuse("NOT_FOUND");
      return work(db);
    });
    return { ok: true, value };
  } catch (err) {
    if (err instanceof FactRefused) return { ok: false, reason: err.reason };
    if ((err as { code?: string }).code === RLS_REFUSED) return { ok: false, reason: "FORBIDDEN" };
    throw err;
  }
}

export const workspaceAudit = (
  db: Db,
  p: Principal,
  action: string,
  type: "space" | "fact" | "entity" | "issue",
  id: string,
  details: object,
  client: Client,
) =>
  db.query("select admin.append_audit_event($1, 'user', $2, $3, $4, $5, $6, $7)", [
    action,
    p.userId,
    type,
    id,
    JSON.stringify(details),
    client.ip,
    uaHash(client),
  ]);

/** The table's own trail. With no fact, `details` holds counts and ids only. */
export const factTrail = (
  db: Db,
  p: Principal,
  spaceId: string,
  factId: string | null,
  action: string,
  details: object = {},
) =>
  db.query(
    `insert into apps.fact_audit (workspace_id, space_id, fact_id, actor_id, action, details)
     values ($1, $2, $3, $4, $5, $6)`,
    [p.workspaceId, spaceId, factId, p.userId, action, JSON.stringify(details)],
  );

/** A file the caller can open in a vault shared with the Space. Inbox files never are. */
export async function spaceVersion(db: Db, spaceId: string, versionId: string) {
  const { rows } = await db.query<{ document_id: string }>(
    `select d.id document_id
       from content.document_version v
       join content.document d on d.id = v.document_id
       join work.space_resource r on r.resource_type = 'vault' and r.resource_id = d.vault_id
                                 and r.space_id = $2 and r.suspended_reason is null
      where v.id = $1`,
    [versionId, spaceId],
  );
  return rows[0] ?? null;
}

export interface LocatedCitation {
  documentId: string;
  versionId: string;
  page: number;
  from: number;
  to: number;
  quote: string;
}

/** Only document quotes are asked about here; nothing else is ever looked up. */
const onePage = (text: string) => ({
  documentPage: async () => text,
  webPage: async () => null,
  cellCitationStatuses: async () => null,
  authorityById: async () => null,
  authoritiesByCitation: async () => [],
  authorityPassages: async () => [],
});

/** A quote kept only if the verifier finds it on that page, as the page words it. */
export async function locateOnPage(
  versionId: string,
  documentId: string,
  page: number,
  text: string,
  quote: string,
): Promise<LocatedCitation | null> {
  const checked = await verifyCitation(
    { kind: "document", documentVersionId: versionId, page, quote },
    onePage(text),
  );
  if (checked.status !== "ok" || !("located" in checked) || !checked.located) return null;
  const { from, to, text: found } = checked.located as { from: number; to: number; text: string };
  return { documentId, versionId, page, from, to, quote: found };
}

async function locateCitation(db: Db, spaceId: string, input: FactCitationInput) {
  const source =
    (await spaceVersion(db, spaceId, input.document_version_id)) ?? refuse("DOCUMENT_NOT_FOUND");
  const { rows } = await db.query<{ text: string }>(
    "select text from content.page where version_id = $1 and page_no = $2",
    [input.document_version_id, input.page_no],
  );
  const page = rows[0] ?? refuse("QUOTE_NOT_FOUND");
  return (
    (await locateOnPage(
      input.document_version_id,
      source.document_id,
      input.page_no,
      page.text,
      input.quote,
    )) ?? refuse("QUOTE_NOT_FOUND")
  );
}

export interface NewFact extends FactWhen {
  spaceId: string;
  source: "extracted" | "manual";
  text: string;
  citations: LocatedCitation[];
  entities: { id: string; via: "manual" | "extracted" }[];
  issues: { id: string; via: "manual" | "extracted" }[];
}

/** Writes a fact whole: itself, its first version, its quotes and its links. */
export async function insertFact(db: Db, p: Principal, fact: NewFact): Promise<string> {
  const sources = [...new Set(fact.citations.map((c) => c.documentId))];
  const { rows } = await db.query<{ id: string }>(
    `insert into apps.fact (workspace_id, space_id, created_by, source, source_documents, text,
       event_date, event_date_end, date_precision)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      p.workspaceId,
      fact.spaceId,
      p.userId,
      fact.source,
      sources,
      fact.text,
      fact.event_date,
      fact.event_date_end,
      fact.date_precision,
    ],
  );
  const id = rows[0]?.id as string;
  await db.query(
    `insert into apps.fact_version (workspace_id, fact_id, no, text, event_date, event_date_end,
       date_precision, entity_ids, issue_ids, edited_by)
     values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9)`,
    [
      p.workspaceId,
      id,
      fact.text,
      fact.event_date,
      fact.event_date_end,
      fact.date_precision,
      fact.entities.map((e) => e.id),
      fact.issues.map((i) => i.id),
      p.userId,
    ],
  );
  for (const c of fact.citations) {
    await db.query(
      `insert into apps.fact_citation (workspace_id, fact_id, document_id, document_version_id,
         page_no, char_from, char_to, quote)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [p.workspaceId, id, c.documentId, c.versionId, c.page, c.from, c.to, c.quote],
    );
  }
  for (const link of fact.entities) await linkTo(db, p, "entity", fact.spaceId, id, link);
  for (const link of fact.issues) await linkTo(db, p, "issue", fact.spaceId, id, link);
  return id;
}

const linkTo = (
  db: Db,
  p: Principal,
  kind: "entity" | "issue",
  spaceId: string,
  factId: string,
  link: { id: string; via: "manual" | "extracted" },
) =>
  db.query(
    `insert into apps.fact_${kind} (workspace_id, space_id, fact_id, ${kind}_id, via)
     values ($1, $2, $3, $4, $5) on conflict do nothing`,
    [p.workspaceId, spaceId, factId, link.id, link.via],
  );

/** Refuses an id the caller can't see in this Space, so nothing hidden is linked by guessing. */
async function known(db: Db, kind: "entity" | "issue", spaceId: string, list: string[]) {
  if (list.length === 0) return;
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int n from apps.${kind} where space_id = $1 and id = any ($2::uuid[])`,
    [spaceId, list],
  );
  if (rows[0]?.n !== list.length) refuse(kind === "entity" ? "UNKNOWN_ENTITY" : "UNKNOWN_ISSUE");
}

interface FactRow extends Omit<Fact, "created_at" | "updated_at" | "citations"> {
  sort_date: string;
  created_at: Date;
  updated_at: Date;
}

// Links to names the caller can't see are left out: the joins run under their policies.
export const FACT_COLUMNS = `f.id, f.space_id, f.text, f.event_date::text event_date,
  f.event_date_end::text event_date_end, f.date_precision, f.status, f.source, f.version_no,
  f.created_by, f.created_at, f.updated_at, f.sort_date::text sort_date,
  array(select e.id from apps.fact_entity l join apps.entity e on e.id = l.entity_id
         where l.fact_id = f.id order by lower(e.canonical_name), e.id) entity_ids,
  array(select i.id from apps.fact_issue l join apps.issue i on i.id = l.issue_id
         where l.fact_id = f.id order by lower(i.name), i.id) issue_ids`;

/** The WHERE clause every list, chronology and export shares. */
export function factWhere(spaceId: string, filter: Omit<FactFilter, "cursor">) {
  const params: unknown[] = [spaceId];
  const where = ["f.space_id = $1"];
  const add = (sql: (n: string) => string, value: unknown) => {
    params.push(value);
    where.push(sql(`$${params.length}`));
  };
  if (filter.status) add((n) => `f.status = ${n}`, filter.status);
  if (filter.documentId) add((n) => `${n}::uuid = any (f.source_documents)`, filter.documentId);
  for (const [kind, id] of [
    ["entity", filter.entityId],
    ["issue", filter.issueId],
  ] as const) {
    if (id) {
      add(
        (n) => `exists (select 1 from apps.fact_${kind} l join apps.${kind} x on x.id = l.${kind}_id
                         where l.fact_id = f.id and x.id = ${n})`,
        id,
      );
    }
  }
  if (filter.from) {
    add(
      (n) => `coalesce(f.event_date_end, case f.date_precision
                when 'month' then (date_trunc('month', f.event_date::timestamp)
                                   + interval '1 month - 1 day')::date
                when 'year' then (date_trunc('year', f.event_date::timestamp)
                                  + interval '1 year - 1 day')::date
                else f.event_date end) >= ${n}::date`,
      filter.from,
    );
  }
  if (filter.to) add((n) => `f.event_date <= ${n}::date`, filter.to);
  return { where: where.join(" and "), params };
}

export async function withCitations(db: Db, rows: FactRow[]): Promise<Fact[]> {
  if (rows.length === 0) return [];
  const { rows: citations } = await db.query<Fact["citations"][number] & { fact_id: string }>(
    `select c.fact_id, c.id citation_id, c.document_id, c.document_version_id version_id,
            d.name document_name, c.page_no, c.char_from, c.char_to, c.quote, c.verified
       from apps.fact_citation c join content.document d on d.id = c.document_id
      where c.fact_id = any ($1::uuid[]) order by c.fact_id, c.id`,
    [rows.map((r) => r.id)],
  );
  return rows.map(({ sort_date: _, ...row }) => ({
    ...row,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    citations: citations.filter((c) => c.fact_id === row.id).map(({ fact_id: _f, ...c }) => c),
  }));
}

async function loadFact(db: Db, spaceId: string, id: string): Promise<Fact> {
  if (!UUID.test(id)) refuse("NOT_FOUND");
  const { rows } = await db.query<FactRow>(
    `select ${FACT_COLUMNS} from apps.fact f where f.id = $1 and f.space_id = $2`,
    [id, spaceId],
  );
  const [fact] = await withCitations(db, rows);
  return fact ?? refuse("NOT_FOUND");
}

/** Locks the fact, so two edits never take the same version. */
async function holdFact(db: Db, spaceId: string, id: string): Promise<Fact> {
  if (UUID.test(id)) await db.query("select 1 from apps.fact where id = $1 for update", [id]);
  return loadFact(db, spaceId, id);
}

const ENTITY_COLUMNS = "id, kind, canonical_name, aliases, role, provisional";
const ISSUE_COLUMNS = "id, name, description";

const words = (text: string) => storable(text);

// A change of case, spacing or punctuation is still the name that was read from the file, so it
// must not make that name the Space's.
const nameKey = (name: string) =>
  name
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}\p{Z}\p{Cf}\s]/gu, "")
    .toLowerCase();

/** Whether a new name says something else than the one there now, which the caller can see. */
async function renames(db: Db, kind: "entity" | "issue", id: string, next: string | undefined) {
  if (next === undefined) return false;
  const column = kind === "entity" ? "canonical_name" : "name";
  const { rows } = await db.query<{ name: string }>(
    `select ${column} name from apps.${kind} where id = $1 for update`,
    [id],
  );
  return rows[0] !== undefined && nameKey(rows[0].name) !== nameKey(next);
}

export function createFacts(pool: pg.Pool): Facts {
  const within = <T>(p: Principal, spaceId: string, work: (db: Db) => Promise<T>) =>
    inFactSpace(pool, p, spaceId, work);

  /** Replaces the links the caller can see; ones hidden from them stay as they are. */
  async function relink(
    db: Db,
    p: Principal,
    kind: "entity" | "issue",
    spaceId: string,
    factId: string,
    wanted: string[],
    had: string[],
  ) {
    await known(
      db,
      kind,
      spaceId,
      wanted.filter((id) => !had.includes(id)),
    );
    const gone = had.filter((id) => !wanted.includes(id));
    if (gone.length) {
      await db.query(
        `delete from apps.fact_${kind} where fact_id = $1 and ${kind}_id = any ($2::uuid[])`,
        [factId, gone],
      );
    }
    for (const id of wanted) {
      if (!had.includes(id)) await linkTo(db, p, kind, spaceId, factId, { id, via: "manual" });
    }
  }

  return {
    async files(p, spaceId) {
      return within(p, spaceId, async (db) => {
        const { rows } = await db.query<FactFile>(
          `select d.id document_id, v.id version_id, d.name, s.id vault_id, s.name vault_name,
                  v.page_count, coalesce(j.status = 'indexed', false) ready
             from content.document d
             join work.space_resource r on r.resource_type = 'vault' and r.resource_id = d.vault_id
                                       and r.space_id = $1 and r.suspended_reason is null
             join content.vault s on s.id = d.vault_id
             join lateral (select x.id, x.page_count from content.document_version x
                            where x.document_id = d.id order by x.version_no desc limit 1) v on true
             left join content.ingest_job j on j.version_id = v.id
            order by lower(s.name), s.id, lower(d.name), d.id
            limit ${FACT_LIMITS.files_listed + 1}`,
          [spaceId],
        );
        return {
          files: rows.slice(0, FACT_LIMITS.files_listed),
          truncated: rows.length > FACT_LIMITS.files_listed,
        };
      });
    },

    async list(p, spaceId, filter) {
      return within(p, spaceId, async (db) => {
        const { where, params } = factWhere(spaceId, filter);
        let after = "";
        if (filter.cursor) {
          const match = CURSOR.exec(filter.cursor) ?? refuse("BAD_CURSOR");
          if (!UUID.test(match[2] ?? "")) refuse("BAD_CURSOR");
          params.push(match[1], match[2]);
          after = ` and (f.sort_date, f.id) > ($${params.length - 1}::date, $${params.length}::uuid)`;
        }
        const { rows } = await db.query<FactRow>(
          `select ${FACT_COLUMNS} from apps.fact f where ${where}${after}
            order by f.sort_date, f.id limit ${FACT_LIMITS.page_size + 1}`,
          params,
        );
        const page = rows.slice(0, FACT_LIMITS.page_size);
        const last = page.at(-1);
        return {
          facts: await withCitations(db, page),
          next_cursor: rows.length > page.length && last ? `${last.sort_date}|${last.id}` : null,
        };
      });
    },

    async get(p, spaceId, id) {
      return within(p, spaceId, (db) => loadFact(db, spaceId, id));
    },

    async create(p, spaceId, input, client) {
      return within(p, spaceId, async (db) => {
        await known(db, "entity", spaceId, input.entity_ids);
        await known(db, "issue", spaceId, input.issue_ids);
        const citations: LocatedCitation[] = [];
        for (const citation of input.citations) {
          citations.push(await locateCitation(db, spaceId, citation));
        }
        const id = await insertFact(db, p, {
          spaceId,
          source: "manual",
          text: words(input.text),
          event_date: input.event_date,
          event_date_end: input.event_date_end,
          date_precision: input.date_precision,
          citations,
          entities: input.entity_ids.map((e) => ({ id: e, via: "manual" })),
          issues: input.issue_ids.map((i) => ({ id: i, via: "manual" })),
        });
        await factTrail(db, p, spaceId, id, "created", { text: words(input.text) });
        await workspaceAudit(
          db,
          p,
          "facts.created_manual",
          "fact",
          id,
          { space_id: spaceId, citations: citations.length },
          client,
        );
        return loadFact(db, spaceId, id);
      });
    },

    async patch(p, spaceId, id, patch, client) {
      return within(p, spaceId, async (db) => {
        const before = await holdFact(db, spaceId, id);
        const next = {
          text: patch.text === undefined ? before.text : words(patch.text),
          event_date: patch.event_date === undefined ? before.event_date : patch.event_date,
          event_date_end:
            patch.event_date_end === undefined ? before.event_date_end : patch.event_date_end,
          date_precision: patch.date_precision ?? before.date_precision,
        };
        if (factWhenProblem(next)) refuse("INVALID");
        const differs = (a: string[], b: string[] | undefined) =>
          b !== undefined && [...a].sort().join() !== [...b].sort().join();
        const changed = [
          ...(["text", "event_date", "event_date_end", "date_precision"] as const).filter(
            (key) => next[key] !== before[key],
          ),
          ...(differs(before.entity_ids, patch.entity_ids) ? ["entity_ids"] : []),
          ...(differs(before.issue_ids, patch.issue_ids) ? ["issue_ids"] : []),
        ];
        if (changed.length === 0) return before;
        await db.query(
          `update apps.fact
              set text = $2, event_date = $3, event_date_end = $4, date_precision = $5,
                  version_no = version_no + 1, updated_at = now()
            where id = $1`,
          [id, next.text, next.event_date, next.event_date_end, next.date_precision],
        );
        if (patch.entity_ids) {
          await relink(db, p, "entity", spaceId, id, patch.entity_ids, before.entity_ids);
        }
        if (patch.issue_ids) {
          await relink(db, p, "issue", spaceId, id, patch.issue_ids, before.issue_ids);
        }
        await db.query(
          `insert into apps.fact_version (workspace_id, fact_id, no, text, event_date,
             event_date_end, date_precision, entity_ids, issue_ids, edited_by)
           select workspace_id, id, version_no, text, event_date, event_date_end, date_precision,
                  array(select entity_id from apps.fact_entity where fact_id = f.id),
                  array(select issue_id from apps.fact_issue where fact_id = f.id), $2
             from apps.fact f where id = $1`,
          [id, p.userId],
        );
        await factTrail(db, p, spaceId, id, "edited", {
          changed,
          before: { text: before.text, event_date: before.event_date },
          after: { text: next.text, event_date: next.event_date },
        });
        await workspaceAudit(
          db,
          p,
          "facts.edited",
          "fact",
          id,
          { space_id: spaceId, fields: changed, version_no: before.version_no + 1 },
          client,
        );
        return loadFact(db, spaceId, id);
      });
    },

    async setStatus(p, spaceId, id, status, client) {
      return within(p, spaceId, async (db) => {
        const before = await holdFact(db, spaceId, id);
        if (before.status === status) return before;
        await db.query("update apps.fact set status = $2, updated_at = now() where id = $1", [
          id,
          status,
        ]);
        const change = { from: before.status, to: status };
        await factTrail(db, p, spaceId, id, "status", change);
        await workspaceAudit(
          db,
          p,
          "facts.status_changed",
          "fact",
          id,
          { space_id: spaceId, ...change },
          client,
        );
        return loadFact(db, spaceId, id);
      });
    },

    async versions(p, spaceId, id) {
      return within(p, spaceId, async (db) => {
        await loadFact(db, spaceId, id);
        const { rows } = await db.query<Omit<FactVersion, "at"> & { at: Date }>(
          `select v.no, v.text, v.event_date::text event_date,
                  v.event_date_end::text event_date_end, v.date_precision,
                  array(select e.id from apps.entity e where e.id = any (v.entity_ids)) entity_ids,
                  array(select i.id from apps.issue i where i.id = any (v.issue_ids)) issue_ids,
                  v.edited_by, v.at
             from apps.fact_version v where v.fact_id = $1 order by v.no desc limit 200`,
          [id],
        );
        return rows.map((v) => ({ ...v, at: v.at.toISOString() }));
      });
    },

    async entities(p, spaceId) {
      return within(p, spaceId, async (db) => {
        const { rows } = await db.query<FactEntity>(
          `select ${ENTITY_COLUMNS} from apps.entity where space_id = $1
            order by lower(canonical_name), id limit ${FACT_LIMITS.list_size}`,
          [spaceId],
        );
        return rows;
      });
    },

    async createEntity(p, spaceId, input, client) {
      return within(p, spaceId, async (db) => {
        const { rows } = await db.query<FactEntity>(
          `insert into apps.entity (workspace_id, space_id, kind, canonical_name, aliases, role,
             origin, created_by)
           values ($1, $2, $3, $4, $5, $6, 'manual', $7) returning ${ENTITY_COLUMNS}`,
          [
            p.workspaceId,
            spaceId,
            input.kind,
            words(input.canonical_name),
            input.aliases.map(words),
            input.role === null ? null : words(input.role),
            p.userId,
          ],
        );
        const entity = rows[0] as FactEntity;
        await workspaceAudit(
          db,
          p,
          "facts.entity_created",
          "entity",
          entity.id,
          { space_id: spaceId },
          client,
        );
        return entity;
      });
    },

    async patchEntity(p, spaceId, id, patch, client) {
      return within(p, spaceId, async (db) => {
        if (!UUID.test(id)) refuse("NOT_FOUND");
        // A name someone types is theirs, and no longer tied to what was extracted.
        const typed = await renames(db, "entity", id, patch.canonical_name);
        const { rows } = await db.query<FactEntity>(
          `update apps.entity
              set kind = coalesce($3, kind),
                  origin = case when $9 then 'manual' else origin end,
                  canonical_name = coalesce($4, canonical_name),
                  aliases = coalesce($5::text[], aliases),
                  role = case when $6 then $7 else role end,
                  provisional = coalesce($8, provisional),
                  updated_at = now()
            where id = $1 and space_id = $2 returning ${ENTITY_COLUMNS}`,
          [
            id,
            spaceId,
            patch.kind ?? null,
            patch.canonical_name === undefined ? null : words(patch.canonical_name),
            patch.aliases?.map(words) ?? null,
            patch.role !== undefined,
            patch.role ? words(patch.role) : null,
            patch.provisional ?? null,
            typed,
          ],
        );
        const entity = rows[0] ?? refuse("NOT_FOUND");
        await workspaceAudit(
          db,
          p,
          "facts.entity_updated",
          "entity",
          id,
          { space_id: spaceId, fields: Object.keys(patch) },
          client,
        );
        return entity;
      });
    },

    async issues(p, spaceId) {
      return within(p, spaceId, async (db) => {
        const { rows } = await db.query<FactIssue>(
          `select ${ISSUE_COLUMNS} from apps.issue where space_id = $1
            order by lower(name), id limit ${FACT_LIMITS.list_size}`,
          [spaceId],
        );
        return rows;
      });
    },

    async createIssue(p, spaceId, input, client) {
      return within(p, spaceId, async (db) => {
        const { rows } = await db.query<FactIssue>(
          `insert into apps.issue (workspace_id, space_id, name, description, origin, created_by)
           values ($1, $2, $3, $4, 'manual', $5) returning ${ISSUE_COLUMNS}`,
          [p.workspaceId, spaceId, words(input.name), words(input.description), p.userId],
        );
        const issue = rows[0] as FactIssue;
        await workspaceAudit(
          db,
          p,
          "facts.issue_created",
          "issue",
          issue.id,
          { space_id: spaceId },
          client,
        );
        return issue;
      });
    },

    async patchIssue(p, spaceId, id, patch, client) {
      return within(p, spaceId, async (db) => {
        if (!UUID.test(id)) refuse("NOT_FOUND");
        const typed = await renames(db, "issue", id, patch.name);
        const { rows } = await db.query<FactIssue>(
          `update apps.issue
              set origin = case when $5 then 'manual' else origin end,
                  name = coalesce($3, name),
                  description = coalesce($4, description),
                  updated_at = now()
            where id = $1 and space_id = $2 returning ${ISSUE_COLUMNS}`,
          [
            id,
            spaceId,
            patch.name === undefined ? null : words(patch.name),
            patch.description === undefined ? null : words(patch.description),
            typed,
          ],
        );
        const issue = rows[0] ?? refuse("NOT_FOUND");
        await workspaceAudit(
          db,
          p,
          "facts.issue_updated",
          "issue",
          id,
          { space_id: spaceId, fields: Object.keys(patch) },
          client,
        );
        return issue;
      });
    },

    async audit(p, spaceId, cursor) {
      return within(p, spaceId, async (db) => {
        if (cursor && !UUID.test(cursor)) refuse("BAD_CURSOR");
        const { rows } = await db.query<Omit<FactAuditEntry, "at"> & { at: Date }>(
          `select id, fact_id, actor_id, action, details, at from apps.fact_audit
            where space_id = $1 and ($2::uuid is null or id < $2)
            order by id desc limit ${FACT_LIMITS.page_size + 1}`,
          [spaceId, cursor ?? null],
        );
        const page = rows.slice(0, FACT_LIMITS.page_size);
        return {
          entries: page.map((e) => ({ ...e, at: e.at.toISOString() })),
          next_cursor: rows.length > page.length ? (page.at(-1)?.id ?? null) : null,
        };
      });
    },
  };
}
