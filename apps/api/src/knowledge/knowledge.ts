import {
  type Authority,
  type AuthoritySources,
  type AuthorityVerification,
  authorityHref,
  normalizeCitation,
  verifyCitation,
} from "@legallabs/citations";
import { type Embedder, EmbedUnavailable } from "@legallabs/embed";
import {
  type AuthorityRecord,
  contentHash,
  filterSchemas,
  isSourceId,
  SOURCES,
  type SourceId,
  type SyncSummary,
  type Upserted,
  type Writer,
} from "@legallabs/knowledge";
import type pg from "pg";
import { z } from "zod";
import type { Principal } from "../auth/auth.js";
import { asApp, asKnowledgeLoader } from "../db.js";

export const MAX_PASSAGES = 50;
const DEFAULT_PASSAGES = 10;
const CANDIDATES = 100;
// Cosine distance past which a "meaning" match is noise; the same cut as document search.
const MAX_DISTANCE = 0.65;
const MAX_QUERY = 2000;
const TEXT_PAGE = 50;
const EMBED_BATCH = 64;
const MAX_PRESETS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One source and the filter chosen for it, as the source picker returns them. */
export interface SourceFilter {
  sourceId: SourceId;
  filter: unknown;
}

export interface Passage {
  chunkId: string;
  authorityRef: string;
  source: SourceId;
  title: string;
  citation: string | null;
  court: string | null;
  docType: string | null;
  date: string | null;
  sectionPath: string | null;
  url: string | null;
  text: string;
}

export interface SourceSummary {
  id: SourceId;
  name: string;
  group: string;
  mode: string;
  jurisdiction: string;
  termsUrl: string;
  attribution: string;
  docCount: number;
  lastRefreshAt: string | null;
  health: "ok" | "degraded" | "down";
}

export interface Facet {
  value: string;
  count: number;
}

export interface SourceDetail extends SourceSummary {
  filterSchema: unknown;
  /** Values read from what is indexed, so the picker never offers one that finds nothing. */
  facets: { courts: Facet[]; docTypes: Facet[]; jurisdictions: Facet[] };
}

export interface AuthorityDetail {
  ref: string;
  source: SourceId;
  title: string;
  court: string | null;
  jurisdiction: string | null;
  docType: string | null;
  date: string | null;
  url: string | null;
  citationStrings: string[];
  firstPage: number | null;
  lastPage: number | null;
  sections: string[];
  meta: Record<string, unknown>;
  attribution: string;
}

export interface TextPage {
  chunks: { id: string; ordinal: number; sectionPath: string | null; text: string }[];
  nextCursor: number | null;
}

export interface Resolved {
  status: "ok" | "mismatch" | "unresolved";
  reason?: string;
  authorityRef?: string;
  /** Set only when the citation reached a stored authority: unresolved ones are never linked. */
  href?: string;
  candidates?: { authorityRef: string; title: string; citation: string | null }[];
  located?: { chunkId: string; from: number; to: number };
}

export interface FilterPreset {
  id: string;
  sourceId: SourceId;
  name: string;
  filter: Record<string, unknown>;
  isDefault: boolean;
  createdAt: string;
}

export type PresetResult =
  | { ok: true; preset: FilterPreset }
  | {
      ok: false;
      reason: "FORBIDDEN" | "NOT_FOUND" | "NAME_TAKEN" | "INVALID_FILTER" | "TOO_MANY";
    };

export interface Knowledge {
  sources(principal: Principal): Promise<SourceSummary[] | null>;
  source(principal: Principal, id: string): Promise<SourceDetail | null>;
  /** Null when a filter does not fit its source or the caller may not use sources. */
  search(
    principal: Principal,
    query: string,
    sources: readonly SourceFilter[],
    limit?: number,
  ): Promise<Passage[] | null>;
  authority(principal: Principal, ref: string): Promise<AuthorityDetail | null>;
  text(principal: Principal, ref: string, cursor: number): Promise<TextPage | null>;
  resolve(
    principal: Principal,
    input: { citation: string; pin?: string; quote?: string; sourceHint?: SourceId },
  ): Promise<Resolved | null>;
  /** For the thread verifier: lookups bound to one caller, so membership is still checked. */
  authoritySources(principal: Principal, sourceHint?: SourceId): AuthoritySources;
  presets(principal: Principal, sourceId: SourceId): Promise<FilterPreset[] | null>;
  createPreset(
    principal: Principal,
    sourceId: SourceId,
    input: { name: string; filter: Record<string, unknown>; isDefault: boolean },
  ): Promise<PresetResult>;
  updatePreset(
    principal: Principal,
    id: string,
    input: { name?: string; filter?: Record<string, unknown>; isDefault?: boolean },
  ): Promise<PresetResult>;
  deletePreset(principal: Principal, id: string): Promise<boolean | null>;
  /** The loader's side: runs as the knowledge role, never as a tenant. */
  writer(): Writer;
}

const attributionOf = (source: string) => SOURCES.find((s) => s.id === source)?.attribution ?? "";

/** Checks a filter against its source's schema; only a filter that fits reaches the SQL. */
export function parseFilter(sourceId: SourceId, filter: unknown): Record<string, unknown> | null {
  const parsed = filterSchemas[sourceId].safeParse(filter ?? {});
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}

// Each source's filter in one shape, so a single query serves every source.
function predicate(sourceId: SourceId, filter: Record<string, unknown>) {
  const f = filter as Record<string, string[] | string | undefined>;
  const edgar = sourceId === "edgar";
  return {
    source: sourceId,
    courts: f.courts ?? null,
    doc_types: (edgar ? f.forms : f.doc_types) ?? null,
    jurisdictions: f.jurisdictions ?? null,
    ciks: f.ciks ?? null,
    date_from: (edgar ? f.filed_from : f.date_from) ?? null,
    date_to: (edgar ? f.filed_to : f.date_to) ?? null,
  };
}

interface AuthorityRow {
  ref: string;
  first_page: number | null;
  last_page: number | null;
  sections: string[];
}

const toAuthority = (row: AuthorityRow): Authority => ({
  id: row.ref,
  ...(row.first_page !== null
    ? { pages: { first: row.first_page, last: row.last_page ?? row.first_page } }
    : {}),
  sections: row.sections,
});

// Lookups for the verifier, inside one caller's transaction.
function lookups(db: pg.PoolClient, sourceHint?: SourceId) {
  return {
    async byRef(ref: string): Promise<Authority | null> {
      const { rows } = await db.query<AuthorityRow>(
        `select ref, first_page, last_page, sections from knowledge.authority
          where ref = $1 and ($2::text is null or source = $2)`,
        [ref, sourceHint ?? null],
      );
      return rows[0] ? toAuthority(rows[0]) : null;
    },
    async byCitation(normalized: string): Promise<Authority[]> {
      const { rows } = await db.query<AuthorityRow>(
        `select a.ref, a.first_page, a.last_page, a.sections
           from knowledge.citation_index i join knowledge.authority a on a.id = i.authority_id
          where i.normalized = $1 and ($2::text is null or a.source = $2)
          order by a.ref limit 20`,
        [normalized, sourceHint ?? null],
      );
      return rows.map(toAuthority);
    },
    async passages(ref: string): Promise<{ id: string; text: string }[]> {
      const { rows } = await db.query<{ id: string; text: string }>(
        `select c.id, c.text from knowledge.authority_chunk c
           join knowledge.authority a on a.id = c.authority_id
          where a.ref = $1 order by c.ordinal`,
        [ref],
      );
      return rows;
    },
  };
}

const canUse = async (db: pg.PoolClient) =>
  (await db.query<{ ok: boolean }>("select core.has_permission('threads.use') as ok")).rows[0]
    ?.ok === true;

interface PassageRow {
  id: string;
  ref: string;
  source: SourceId;
  title: string;
  citation: string | null;
  court: string | null;
  doc_type: string | null;
  decided_on: string | null;
  section_path: string | null;
  url: string | null;
  text: string;
}

const toPassage = (row: PassageRow): Passage => ({
  chunkId: row.id,
  authorityRef: row.ref,
  source: row.source,
  title: row.title,
  citation: row.citation,
  court: row.court,
  docType: row.doc_type,
  date: row.decided_on,
  sectionPath: row.section_path,
  url: row.url,
  text: row.text,
});

interface PresetRow {
  id: string;
  source_id: SourceId;
  name: string;
  filter: Record<string, unknown>;
  is_default: boolean;
  created_at: Date;
}

const PRESET_COLUMNS = "id, source_id, name, filter, is_default, created_at";

const toPreset = (row: PresetRow): FilterPreset => ({
  id: row.id,
  sourceId: row.source_id,
  name: row.name,
  filter: row.filter,
  isDefault: row.is_default,
  createdAt: row.created_at.toISOString(),
});

const isUniqueViolation = (err: unknown) =>
  typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";

async function audit(
  db: pg.PoolClient,
  principal: Principal,
  action: string,
  preset: { id: string; source_id: string },
) {
  await db.query("select admin.append_audit_event($1, 'user', $2, 'filter_preset', $3, $4)", [
    action,
    principal.userId,
    preset.id,
    JSON.stringify({ source_id: preset.source_id }),
  ]);
}

export interface KnowledgeOptions {
  /** Adds meaning-based matches to keyword search. Must be the model the loader used. */
  embedder?: Embedder | null;
}

export function createKnowledge(pool: pg.Pool, options: KnowledgeOptions = {}): Knowledge {
  const embedder = options.embedder ?? null;

  async function embedQuery(query: string): Promise<string | null> {
    if (!embedder) return null;
    try {
      const [vector] = await embedder.embed([query]);
      return vector ? `[${vector.join(",")}]` : null;
    } catch (err) {
      // Keyword search still answers when the model server is down.
      if (err instanceof EmbedUnavailable) return null;
      throw err;
    }
  }

  async function sources(principal: Principal): Promise<SourceSummary[] | null> {
    return asApp(pool, principal, async (db) => {
      if (!(await canUse(db))) return null;
      const { rows } = await db.query<{
        source: string;
        doc_count: string;
        last_refresh_at: Date | null;
        health: "ok" | "degraded" | "down";
      }>("select source, doc_count, last_refresh_at, health from knowledge.source_state");
      const state = new Map(rows.map((row) => [row.source, row]));
      return SOURCES.map((info) => {
        const row = state.get(info.id);
        return {
          ...info,
          docCount: Number(row?.doc_count ?? 0),
          lastRefreshAt: row?.last_refresh_at?.toISOString() ?? null,
          health: row?.health ?? "ok",
        };
      });
    });
  }

  return {
    sources,

    async source(principal, id) {
      if (!isSourceId(id)) return null;
      const summary = (await sources(principal))?.find((s) => s.id === id);
      if (!summary) return null;
      const facets = await asApp(pool, principal, async (db) => {
        const facet = async (column: "court" | "doc_type" | "jurisdiction") => {
          const { rows } = await db.query<{ value: string; count: string }>(
            `select ${column} as value, count(*) as count from knowledge.authority
              where source = $1 and ${column} is not null
              group by 1 order by 2 desc, 1 limit 200`,
            [id],
          );
          return rows.map((row) => ({ value: row.value, count: Number(row.count) }));
        };
        return {
          courts: await facet("court"),
          docTypes: await facet("doc_type"),
          jurisdictions: await facet("jurisdiction"),
        };
      });
      return { ...summary, filterSchema: z.toJSONSchema(filterSchemas[id]), facets };
    },

    async search(principal, query, picked, limit = DEFAULT_PASSAGES) {
      const take = Math.max(1, Math.min(MAX_PASSAGES, Math.trunc(limit)));
      const text = query.replaceAll("\0", "").slice(0, MAX_QUERY);
      const filters: ReturnType<typeof predicate>[] = [];
      for (const { sourceId, filter } of picked) {
        const parsed = parseFilter(sourceId, filter);
        if (parsed === null) return null;
        filters.push(predicate(sourceId, parsed));
      }
      if (filters.length === 0) return [];
      // Embedded outside the transaction, so a slow model never holds a connection.
      const vector = await embedQuery(text);
      const rows = await asApp(pool, principal, async (db) => {
        if (!(await canUse(db))) return null;
        const result = await db.query<PassageRow>(
          `with words as (
             -- Any word may match; the ranking, not the match, decides what comes first.
             -- Plain words only: search syntax such as -word has no meaning here.
             select replace(w::text, ' & ', ' | ')::tsquery q
               from plainto_tsquery('english', $1) w
           ), wanted as (
             select * from jsonb_to_recordset($2::jsonb) as f(
               source text, courts text[], doc_types text[], jurisdictions text[],
               ciks text[], date_from date, date_to date)
           ), scope as not materialized (
             select c.id, c.authority_id, c.ordinal, c.section_path, c.text, c.tsv,
                    c.embedding, c.embedding_model,
                    a.ref, a.source, a.title, a.court, a.doc_type, a.decided_on, a.url,
                    a.citation_strings[1] as citation
               from knowledge.authority a
               join wanted f on f.source = a.source
               join knowledge.authority_chunk c on c.authority_id = a.id
              where (f.courts is null or a.court = any(f.courts))
                and (f.doc_types is null or a.doc_type = any(f.doc_types))
                and (f.jurisdictions is null or a.jurisdiction = any(f.jurisdictions))
                and (f.ciks is null or a.meta->>'cik' = any(f.ciks))
                and (f.date_from is null or a.decided_on >= f.date_from)
                and (f.date_to is null or a.decided_on <= f.date_to)
           ), cited as (
             -- A query that is itself a citation finds that authority first.
             select s.id, row_number() over (order by s.ordinal, s.id) r
               from scope s
               join knowledge.citation_index i on i.authority_id = s.authority_id
              where i.normalized = $3
              order by r limit 5
           ), lexical as (
             select s.id, row_number() over (order by ts_rank_cd(s.tsv, w.q) desc, s.id) r
               from scope s, words w
              where s.tsv @@ w.q
              order by r limit $5
           ), dense as (
             select s.id, row_number() over (order by s.embedding <=> $4::vector, s.id) r
               from scope s
              where $4::vector is not null and s.embedding_model = $6
                and s.embedding <=> $4::vector <= $7
              order by r limit $5
           ), fused as (
             -- Reciprocal rank fusion: rank, not raw score, so the lists can be compared.
             -- The scope joins come first, so filters hold; past ~100k chunks per source,
             -- an over-fetching HNSW query should replace the exact distance scan.
             select id, sum(1.0 / (60 + r)) score
               from (select * from cited union all select * from lexical
                     union all select * from dense) ranked
              group by id
           )
           select s.id, s.ref, s.source, s.title, s.citation, s.court, s.doc_type,
                  to_char(s.decided_on, 'YYYY-MM-DD') as decided_on, s.section_path, s.url, s.text
             from fused f join scope s on s.id = f.id
            order by f.score desc, s.id
            limit $8`,
          [
            text,
            JSON.stringify(filters),
            normalizeCitation(text),
            vector,
            CANDIDATES,
            embedder?.model ?? null,
            MAX_DISTANCE,
            take,
          ],
        );
        return result.rows;
      });
      return rows === null ? null : rows.map(toPassage);
    },

    async authority(principal, ref) {
      return asApp(pool, principal, async (db) => {
        if (!(await canUse(db))) return null;
        const { rows } = await db.query<{
          ref: string;
          source: SourceId;
          title: string;
          court: string | null;
          jurisdiction: string | null;
          doc_type: string | null;
          decided_on: string | null;
          url: string | null;
          citation_strings: string[];
          first_page: number | null;
          last_page: number | null;
          sections: string[];
          meta: Record<string, unknown>;
        }>(
          `select ref, source, title, court, jurisdiction, doc_type,
                  to_char(decided_on, 'YYYY-MM-DD') as decided_on, url, citation_strings,
                  first_page, last_page, sections, meta
             from knowledge.authority where ref = $1`,
          [ref],
        );
        const row = rows[0];
        if (!row) return null;
        return {
          ref: row.ref,
          source: row.source,
          title: row.title,
          court: row.court,
          jurisdiction: row.jurisdiction,
          docType: row.doc_type,
          date: row.decided_on,
          url: row.url,
          citationStrings: row.citation_strings,
          firstPage: row.first_page,
          lastPage: row.last_page,
          sections: row.sections,
          meta: row.meta,
          attribution: attributionOf(row.source),
        };
      });
    },

    async text(principal, ref, cursor) {
      return asApp(pool, principal, async (db) => {
        if (!(await canUse(db))) return null;
        const exists = await db.query("select 1 from knowledge.authority where ref = $1", [ref]);
        if (exists.rowCount === 0) return null;
        const { rows } = await db.query<{
          id: string;
          ordinal: number;
          section_path: string | null;
          text: string;
        }>(
          `select c.id, c.ordinal, c.section_path, c.text
             from knowledge.authority a
             join knowledge.authority_chunk c on c.authority_id = a.id
            where a.ref = $1 and c.ordinal >= $2
            order by c.ordinal limit $3`,
          [ref, cursor, TEXT_PAGE + 1],
        );
        return {
          chunks: rows.slice(0, TEXT_PAGE).map((row) => ({
            id: row.id,
            ordinal: row.ordinal,
            sectionPath: row.section_path,
            text: row.text,
          })),
          nextCursor: rows[TEXT_PAGE]?.ordinal ?? null,
        };
      });
    },

    async resolve(principal, input) {
      return asApp(pool, principal, async (db) => {
        if (!(await canUse(db))) return null;
        const look = lookups(db, input.sourceHint);
        let chunkIds: string[] = [];
        const result = (await verifyCitation(
          {
            kind: "authority",
            reference: input.citation,
            ...(input.pin === undefined ? {} : { pin: input.pin }),
            ...(input.quote === undefined ? {} : { quote: input.quote }),
          },
          {
            authorityById: look.byRef,
            authoritiesByCitation: look.byCitation,
            async authorityPassages(id) {
              const found = await look.passages(id);
              chunkIds = found.map((p) => p.id);
              return found.map((p) => p.text);
            },
            documentPage: async () => null,
            webPage: async () => null,
            cellCitationStatuses: async () => null,
          },
        )) as AuthorityVerification;
        return describeResult(db, result, chunkIds);
      });
    },

    authoritySources(principal, sourceHint) {
      const inTx = <T>(work: (look: ReturnType<typeof lookups>) => Promise<T>) =>
        asApp(pool, principal, async (db) => {
          // A lookup failure rejects, so it is never mistaken for an unresolved citation.
          if (!(await canUse(db))) throw new Error("not allowed to use knowledge sources");
          return work(lookups(db, sourceHint));
        });
      return {
        authorityById: (id) => inTx((look) => look.byRef(id)),
        authoritiesByCitation: (normalized) => inTx((look) => look.byCitation(normalized)),
        authorityPassages: (id) =>
          inTx(async (look) => (await look.passages(id)).map((p) => p.text)),
      };
    },

    async presets(principal, sourceId) {
      return asApp(pool, principal, async (db) => {
        if (!(await canUse(db))) return null;
        const { rows } = await db.query<PresetRow>(
          `select ${PRESET_COLUMNS} from knowledge.source_filter_preset
            where source_id = $1 and user_id = core.current_user_id()
            order by is_default desc, name`,
          [sourceId],
        );
        return rows.map(toPreset);
      });
    },

    async createPreset(principal, sourceId, input) {
      const filter = parseFilter(sourceId, input.filter);
      if (filter === null) return { ok: false, reason: "INVALID_FILTER" };
      try {
        return await asApp(pool, principal, async (db): Promise<PresetResult> => {
          if (!(await canUse(db))) return { ok: false, reason: "FORBIDDEN" };
          const { rows: count } = await db.query<{ n: string }>(
            `select count(*) as n from knowledge.source_filter_preset
              where source_id = $1 and user_id = core.current_user_id()`,
            [sourceId],
          );
          if (Number(count[0]?.n ?? 0) >= MAX_PRESETS) return { ok: false, reason: "TOO_MANY" };
          // One default per source: setting a new one clears the old.
          if (input.isDefault) {
            await db.query(
              `update knowledge.source_filter_preset set is_default = false
                where source_id = $1 and user_id = core.current_user_id() and is_default`,
              [sourceId],
            );
          }
          const { rows } = await db.query<PresetRow>(
            `insert into knowledge.source_filter_preset
               (workspace_id, user_id, source_id, name, filter, is_default)
             values (core.current_workspace_id(), core.current_user_id(), $1, $2, $3, $4)
             returning ${PRESET_COLUMNS}`,
            [sourceId, input.name, JSON.stringify(filter), input.isDefault],
          );
          const row = rows[0];
          if (!row) throw new Error("insert returned no row");
          await audit(db, principal, "knowledge.filter_preset.created", row);
          return { ok: true, preset: toPreset(row) };
        });
      } catch (err) {
        if (isUniqueViolation(err)) return { ok: false, reason: "NAME_TAKEN" };
        throw err;
      }
    },

    async updatePreset(principal, id, input) {
      if (!UUID.test(id)) return { ok: false, reason: "NOT_FOUND" };
      try {
        return await asApp(pool, principal, async (db): Promise<PresetResult> => {
          if (!(await canUse(db))) return { ok: false, reason: "FORBIDDEN" };
          const { rows: found } = await db.query<PresetRow>(
            `select ${PRESET_COLUMNS} from knowledge.source_filter_preset
              where id = $1 for update`,
            [id],
          );
          const current = found[0];
          if (!current) return { ok: false, reason: "NOT_FOUND" };
          const filter =
            input.filter === undefined ? undefined : parseFilter(current.source_id, input.filter);
          if (filter === null) return { ok: false, reason: "INVALID_FILTER" };
          if (input.isDefault) {
            await db.query(
              `update knowledge.source_filter_preset set is_default = false
                where source_id = $1 and user_id = core.current_user_id()
                  and is_default and id <> $2`,
              [current.source_id, id],
            );
          }
          const { rows } = await db.query<PresetRow>(
            `update knowledge.source_filter_preset
                set name = coalesce($2, name), filter = coalesce($3::jsonb, filter),
                    is_default = coalesce($4, is_default)
              where id = $1
              returning ${PRESET_COLUMNS}`,
            [
              id,
              input.name ?? null,
              filter === undefined ? null : JSON.stringify(filter),
              input.isDefault ?? null,
            ],
          );
          const row = rows[0];
          if (!row) return { ok: false, reason: "NOT_FOUND" };
          await audit(db, principal, "knowledge.filter_preset.updated", row);
          return { ok: true, preset: toPreset(row) };
        });
      } catch (err) {
        if (isUniqueViolation(err)) return { ok: false, reason: "NAME_TAKEN" };
        throw err;
      }
    },

    async deletePreset(principal, id) {
      if (!UUID.test(id)) return false;
      return asApp(pool, principal, async (db) => {
        if (!(await canUse(db))) return null;
        const { rows } = await db.query<{ id: string; source_id: string }>(
          "delete from knowledge.source_filter_preset where id = $1 returning id, source_id",
          [id],
        );
        const row = rows[0];
        if (!row) return false;
        await audit(db, principal, "knowledge.filter_preset.deleted", row);
        return true;
      });
    },

    writer() {
      return createWriter(pool, embedder);
    },
  };
}

async function describeResult(
  db: pg.PoolClient,
  result: AuthorityVerification,
  chunkIds: readonly string[],
): Promise<Resolved> {
  if (result.status === "unresolved") {
    if (result.reason !== "ambiguous_authority") {
      return { status: "unresolved", reason: result.reason };
    }
    const { rows } = await db.query<{ ref: string; title: string; citation: string | null }>(
      `select ref, title, citation_strings[1] as citation from knowledge.authority
        where ref = any($1::text[]) order by ref`,
      [result.candidates],
    );
    return {
      status: "unresolved",
      reason: result.reason,
      candidates: rows.map((row) => ({
        authorityRef: row.ref,
        title: row.title,
        citation: row.citation,
      })),
    };
  }
  const href = authorityHref(result);
  const base = { authorityRef: result.authorityId, ...(href === null ? {} : { href }) };
  if (result.status === "mismatch") return { status: "mismatch", reason: result.reason, ...base };
  const located = "located" in result ? result.located : undefined;
  const chunkId = located ? chunkIds[located.passage] : undefined;
  return {
    status: "ok",
    ...base,
    ...(located && chunkId ? { located: { chunkId, from: located.from, to: located.to } } : {}),
  };
}

function createWriter(pool: pg.Pool, embedder: Embedder | null): Writer {
  return {
    async upsert(record: AuthorityRecord): Promise<Upserted> {
      const hash = contentHash(record);
      const existing = await asKnowledgeLoader(pool, async (db) => {
        const { rows } = await db.query<{ content_hash: string; stale: boolean }>(
          // Stale only when there is a model to embed with and a chunk lacks its vectors.
          `select a.content_hash,
                  $2::text is not null and exists (
                    select 1 from knowledge.authority_chunk c
                     where c.authority_id = a.id
                       and c.embedding_model is distinct from $2) as stale
             from knowledge.authority a where a.ref = $1`,
          [record.ref, embedder?.model ?? null],
        );
        return rows[0] ?? null;
      });
      // Unchanged text, already embedded with today's model, needs nothing.
      if (existing && existing.content_hash === hash && !existing.stale) return "unchanged";

      // Embedded before the write, so a slow model never holds a transaction open.
      let vectors: (string | null)[] = record.chunks.map(() => null);
      if (embedder) {
        try {
          const out: string[] = [];
          for (let i = 0; i < record.chunks.length; i += EMBED_BATCH) {
            const batch = record.chunks.slice(i, i + EMBED_BATCH).map((c) => c.text);
            const embedded = await embedder.embed(batch);
            // One vector per chunk, or every later vector would sit on the wrong text.
            if (embedded.length !== batch.length) throw new EmbedUnavailable("vector count");
            for (const vector of embedded) out.push(`[${vector.join(",")}]`);
          }
          vectors = out;
        } catch (err) {
          if (!(err instanceof EmbedUnavailable)) throw err;
          // Same text: keep the vectors it has rather than wiping them.
          if (existing?.content_hash === hash) return "unchanged";
          // New text is stored without vectors; the next sync finds it stale and tries again.
        }
      }

      const citations = new Map<string, string>();
      for (const citation of record.citations) {
        const normalized = normalizeCitation(citation.text).slice(0, 500);
        if (normalized && !citations.has(normalized)) citations.set(normalized, citation.kind);
      }
      const official = record.citations.filter((c) => c.kind !== "alias").map((c) => c.text);

      await asKnowledgeLoader(pool, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `insert into knowledge.authority
             (ref, source, title, court, jurisdiction, doc_type, decided_on, url,
              citation_strings, first_page, last_page, sections, meta, content_hash)
           values ($1, split_part($1, ':', 1), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           on conflict (ref) do update set
             title = excluded.title, court = excluded.court, jurisdiction = excluded.jurisdiction,
             doc_type = excluded.doc_type, decided_on = excluded.decided_on, url = excluded.url,
             citation_strings = excluded.citation_strings, first_page = excluded.first_page,
             last_page = excluded.last_page, sections = excluded.sections, meta = excluded.meta,
             content_hash = excluded.content_hash, updated_at = now()
           returning id`,
          [
            record.ref,
            record.title,
            record.court ?? null,
            record.jurisdiction ?? null,
            record.docType ?? null,
            record.decidedOn ?? null,
            record.url ?? null,
            official,
            record.firstPage ?? null,
            record.lastPage ?? null,
            record.sections,
            JSON.stringify(record.meta),
            hash,
          ],
        );
        const id = (rows[0] as { id: string }).id;
        // Replaced whole, so a chunk or citation that left upstream leaves here too.
        await db.query("delete from knowledge.authority_chunk where authority_id = $1", [id]);
        await db.query(
          `insert into knowledge.authority_chunk
             (authority_id, ordinal, section_path, text, embedding, embedding_model)
           select $1, t.ordinal - 1, t.section_path, t.text, t.embedding::vector,
                  case when t.embedding is null then null else $5 end
             from unnest($2::text[], $3::text[], $4::text[]) with ordinality
                  as t(section_path, text, embedding, ordinal)`,
          [
            id,
            record.chunks.map((c) => c.sectionPath),
            record.chunks.map((c) => c.text),
            vectors,
            embedder?.model ?? null,
          ],
        );
        await db.query("delete from knowledge.citation_index where authority_id = $1", [id]);
        await db.query(
          `insert into knowledge.citation_index (normalized, authority_id, kind)
           select n, $1, k from unnest($2::text[], $3::text[]) as t(n, k)
           on conflict do nothing`,
          [id, [...citations.keys()], [...citations.values()]],
        );
      });
      return existing ? "updated" : "added";
    },

    async finish(source: SourceId, summary: SyncSummary) {
      const loaded = summary.added + summary.updated + summary.unchanged;
      const health = summary.failed.length === 0 ? "ok" : loaded > 0 ? "degraded" : "down";
      await asKnowledgeLoader(pool, (db) =>
        db.query(
          `insert into knowledge.source_state (source, cursor, doc_count, last_refresh_at, health)
           values ($1, $2, (select count(*) from knowledge.authority where source = $1), now(), $3)
           on conflict (source) do update set
             cursor = excluded.cursor, doc_count = excluded.doc_count,
             last_refresh_at = excluded.last_refresh_at, health = excluded.health`,
          [
            source,
            JSON.stringify({
              added: summary.added,
              updated: summary.updated,
              unchanged: summary.unchanged,
              failed: summary.failed.slice(0, 50),
            }),
            health,
          ],
        ),
      );
    },
  };
}
