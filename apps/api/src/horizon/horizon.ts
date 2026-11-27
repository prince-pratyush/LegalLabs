import {
  HORIZON_LIMITS,
  HORIZON_SOURCES,
  type HorizonItem,
  type HorizonScan,
  type HorizonScanCreate,
  type HorizonScanPatch,
  type HorizonSource,
} from "@legallabs/contracts";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp, RLS_REFUSED } from "../db.js";

// Horizon scans and what they found. Everything is the owner's alone; the database says so too.

export type Db = pg.PoolClient;

export type HorizonFailure =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "DISABLED"
  | "FROM_DATE_TOO_EARLY"
  | "FROM_DATE_IN_FUTURE"
  | "SOURCE_OUTSIDE_JURISDICTIONS"
  | "TOO_MANY_SCANS"
  | "BAD_CURSOR";

export type HorizonResult<T> = { ok: true; value: T } | { ok: false; reason: HorizonFailure };

const done = <T>(value: T): HorizonResult<T> => ({ ok: true, value });
const refused = (reason: HorizonFailure) => ({ ok: false as const, reason });

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const audit = (
  db: Db,
  p: Principal,
  action: string,
  type: string,
  id: string | null,
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

export async function enabled(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ enabled: boolean }>(
    "select enabled from apps.horizon_settings",
  );
  return rows[0]?.enabled ?? false;
}

/** Making, changing and refreshing a scan spends on a model, so it takes both permissions. */
export async function mayRun(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `select apps.horizon_member() and core.has_permission('horizon.create')
        and core.has_permission('threads.use') ok`,
  );
  return rows[0]?.ok ?? false;
}

// An item with no say from its reader is archived once it is a year old.
export const ARCHIVED = `coalesce(st.archived,
  i.created_at < now() - make_interval(days => ${HORIZON_LIMITS.keep_days}))`;

const SCAN = `s.id, s.name, s.purpose, s.jurisdictions, s.industries, s.topics, s.sources,
  to_char(s.from_date, 'YYYY-MM-DD') from_date, s.relevance_floor, s.stopped,
  s.last_refresh_at, s.next_refresh_at, s.created_at,
  array(select c.source_id from apps.horizon_cursor c
         where c.scan_id = s.id and c.failures >= 3 and c.source_id = any (s.sources)
         order by c.source_id) failing_sources,
  n.items, n.unread, n.high`;
const SCAN_FROM = `apps.horizon_scan s
  cross join lateral (
    select count(*)::int items,
      count(*) filter (where st.read_at is null and not ${ARCHIVED})::int unread,
      count(*) filter (where i.relevance = 'high' and not ${ARCHIVED})::int high
      from apps.horizon_item i
      left join apps.horizon_item_state st
        on st.item_id = i.id and st.user_id = core.current_user_id()
     where i.scan_id = s.id) n`;

type ScanRow = Omit<
  HorizonScan,
  "health" | "last_refresh_at" | "next_refresh_at" | "created_at"
> & {
  last_refresh_at: Date | null;
  next_refresh_at: Date;
  created_at: Date;
};

const scanView = (row: ScanRow): HorizonScan => ({
  ...row,
  health: row.failing_sources.length > 0 ? "degraded" : "ok",
  last_refresh_at: row.last_refresh_at?.toISOString() ?? null,
  next_refresh_at: row.stopped ? null : row.next_refresh_at.toISOString(),
  created_at: row.created_at.toISOString(),
});

export const ITEM = `i.id, i.scan_id, i.title development, i.summary, i.relevance, i.explanation,
  i.doc_type "type", i.industries, i.topics, i.jurisdiction, i.source_id,
  to_char(i.published_on, 'YYYY-MM-DD') published_at, i.url source_url,
  st.read_at is not null "read", coalesce(st.starred, false) starred, ${ARCHIVED} archived`;
export const ITEM_FROM = `apps.horizon_item i
  left join apps.horizon_item_state st
    on st.item_id = i.id and st.user_id = core.current_user_id()`;

export interface ItemRow {
  id: string;
  scan_id: string;
  development: string;
  summary: string;
  relevance: HorizonItem["relevance"];
  explanation: string;
  type: string;
  industries: string[];
  topics: string[];
  jurisdiction: "US" | "UK";
  source_id: HorizonSource;
  published_at: string;
  source_url: string;
  read: boolean;
  starred: boolean;
  archived: boolean;
}

export const itemView = ({
  jurisdiction,
  source_id,
  read,
  starred,
  archived,
  ...row
}: ItemRow): HorizonItem => ({
  ...row,
  jurisdictions: [jurisdiction],
  sources: [source_id],
  state: { read, starred, archived },
});

// "2026-03-01_<uuid>": where the last page ended.
const CURSOR =
  /^(\d{4}-\d{2}-\d{2})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const dayBefore = (when: Date, days: number) =>
  new Date(when.getTime() - days * 86_400_000).toISOString().slice(0, 10);

/** What is wrong with a scan's start and sources, judged from the day it was made. */
function unsound(
  scan: { from_date?: string; sources: string[]; jurisdictions: string[] },
  made: Date,
): HorizonFailure | null {
  if (scan.from_date !== undefined) {
    if (scan.from_date < dayBefore(made, HORIZON_LIMITS.from_days)) return "FROM_DATE_TOO_EARLY";
    if (scan.from_date > dayBefore(new Date(), 0)) return "FROM_DATE_IN_FUTURE";
  }
  const outside = HORIZON_SOURCES.some(
    (source) =>
      scan.sources.includes(source.id) &&
      scan.jurisdictions.length > 0 &&
      !scan.jurisdictions.includes(source.jurisdiction),
  );
  return outside ? "SOURCE_OUTSIDE_JURISDICTIONS" : null;
}

const unique = <T>(list: T[]) => [...new Set(list)];

export function createHorizon(pool: pg.Pool) {
  /** Runs for a member of a workspace with scanning on. */
  const on = <T>(p: Principal, work: (db: Db) => Promise<HorizonResult<T>>) =>
    asApp(pool, p, async (db): Promise<HorizonResult<T>> => {
      const { rows } = await db.query<{ ok: boolean }>("select apps.horizon_member() ok");
      if (!rows[0]?.ok) return refused("FORBIDDEN");
      if (!(await enabled(db))) return refused("DISABLED");
      return work(db);
    });

  const load = async (db: Db, id: string) => {
    const { rows } = await db.query<ScanRow>(`select ${SCAN} from ${SCAN_FROM} where s.id = $1`, [
      id,
    ]);
    return rows[0] ? scanView(rows[0]) : null;
  };

  return {
    settings: (p: Principal) =>
      asApp(pool, p, async (db) => {
        const { rows } = await db.query<{ member: boolean; manage: boolean; create: boolean }>(
          `select apps.horizon_member() member, core.has_permission('admin.config') manage,
              core.has_permission('horizon.create') and core.has_permission('threads.use') "create"`,
        );
        const may = rows[0];
        const isOn = may?.member === true && (await enabled(db));
        return {
          enabled: isOn,
          can_manage: may?.manage === true,
          can_create: isOn && may?.create === true,
        };
      }),

    async setEnabled(
      p: Principal,
      value: boolean,
      client: Client,
    ): Promise<HorizonResult<boolean>> {
      return asApp(pool, p, async (db) => {
        const { rows } = await db.query<{ ok: boolean }>(
          "select core.has_permission('admin.config') ok",
        );
        if (!rows[0]?.ok) return refused("FORBIDDEN");
        await db.query(
          `insert into apps.horizon_settings (workspace_id, enabled) values ($1, $2)
           on conflict (workspace_id) do update set enabled = $2, updated_at = now()`,
          [p.workspaceId, value],
        );
        await audit(
          db,
          p,
          "horizon.settings.updated",
          "workspace",
          p.workspaceId,
          { enabled: value },
          client,
        );
        return done(value);
      });
    },

    list: (p: Principal) =>
      on(p, async (db) => {
        const { rows } = await db.query<ScanRow>(
          `select ${SCAN} from ${SCAN_FROM} order by s.id desc limit ${HORIZON_LIMITS.scans}`,
        );
        return done(rows.map(scanView));
      }),

    get: (p: Principal, id: string) =>
      on(p, async (db) => {
        const scan = UUID.test(id) ? await load(db, id) : null;
        return scan ? done(scan) : refused("NOT_FOUND");
      }),

    async create(p: Principal, input: HorizonScanCreate, client: Client) {
      const sources = unique(input.sources);
      const problem = unsound({ ...input, sources }, new Date());
      try {
        return await on<HorizonScan>(p, async (db) => {
          if (!(await mayRun(db))) return refused("FORBIDDEN");
          if (problem) return refused(problem);
          const { rows } = await db.query<{ id: string }>(
            `insert into apps.horizon_scan (workspace_id, owner_id, name, purpose, jurisdictions,
               industries, topics, sources, from_date, relevance_floor)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
            [
              p.workspaceId,
              p.userId,
              input.name,
              input.purpose,
              unique(input.jurisdictions),
              unique(input.industries),
              unique(input.topics),
              sources,
              input.from_date,
              input.relevance_floor,
            ],
          );
          const id = rows[0]?.id as string;
          await audit(
            db,
            p,
            "horizon.scan.created",
            "scan",
            id,
            { sources: sources.length },
            client,
          );
          return done((await load(db, id)) as HorizonScan);
        });
      } catch (err) {
        const { code } = err as { code?: string };
        if (code === "54000") return refused("TOO_MANY_SCANS");
        if (code === RLS_REFUSED) return refused("FORBIDDEN");
        throw err;
      }
    },

    async update(p: Principal, id: string, patch: HorizonScanPatch, client: Client) {
      return on<HorizonScan>(p, async (db) => {
        if (!UUID.test(id)) return refused("NOT_FOUND");
        await db.query("select 1 from apps.horizon_scan where id = $1 for update", [id]);
        const before = await load(db, id);
        if (!before) return refused("NOT_FOUND");
        if (!(await mayRun(db))) return refused("FORBIDDEN");
        const next = {
          name: patch.name ?? before.name,
          purpose: patch.purpose ?? before.purpose,
          jurisdictions: unique(patch.jurisdictions ?? before.jurisdictions),
          industries: unique(patch.industries ?? before.industries),
          topics: unique(patch.topics ?? before.topics),
          sources: unique(patch.sources ?? before.sources),
          from_date: patch.from_date ?? before.from_date,
          relevance_floor: patch.relevance_floor ?? before.relevance_floor,
        };
        const moved = next.from_date !== before.from_date;
        const problem = unsound(
          {
            sources: next.sources,
            jurisdictions: next.jurisdictions,
            ...(moved ? { from_date: next.from_date } : {}),
          },
          new Date(before.created_at),
        );
        if (problem) return refused(problem);
        // A new start is read again from there; what was already found is not graded twice.
        if (moved) await db.query("delete from apps.horizon_cursor where scan_id = $1", [id]);
        const due =
          moved || before.stopped || next.sources.some((s) => !before.sources.includes(s));
        await db.query(
          `update apps.horizon_scan set name = $2, purpose = $3, jurisdictions = $4,
             industries = $5, topics = $6, sources = $7, from_date = $8, relevance_floor = $9,
             stopped = false, updated_at = now(),
             next_refresh_at = case when $10 then least(next_refresh_at, now())
                                    else next_refresh_at end
           where id = $1`,
          [
            id,
            next.name,
            next.purpose,
            next.jurisdictions,
            next.industries,
            next.topics,
            next.sources,
            next.from_date,
            next.relevance_floor,
            due,
          ],
        );
        await audit(
          db,
          p,
          "horizon.scan.updated",
          "scan",
          id,
          { fields: Object.keys(patch) },
          client,
        );
        return done((await load(db, id)) as HorizonScan);
      });
    },

    remove: (p: Principal, id: string, client: Client) =>
      on<null>(p, async (db) => {
        if (!UUID.test(id)) return refused("NOT_FOUND");
        const { rowCount } = await db.query("delete from apps.horizon_scan where id = $1", [id]);
        if (!rowCount) return refused("NOT_FOUND");
        await audit(db, p, "horizon.scan.deleted", "scan", id, {}, client);
        return done(null);
      }),

    items: (p: Principal, scanId: string, query: { cursor?: string | undefined }) =>
      on<{ items: HorizonItem[]; next_cursor: string | null }>(p, async (db) => {
        const at = query.cursor === undefined ? null : CURSOR.exec(query.cursor);
        if (query.cursor !== undefined && !at) return refused("BAD_CURSOR");
        const seen = UUID.test(scanId)
          ? await db.query("select 1 from apps.horizon_scan where id = $1", [scanId])
          : null;
        if (!seen?.rowCount) return refused("NOT_FOUND");
        const { rows } = await db.query<ItemRow>(
          `select ${ITEM} from ${ITEM_FROM}
            where i.scan_id = $1
              and ($2::date is null or (i.published_on, i.id) < ($2::date, $3::uuid))
            order by i.published_on desc, i.id desc
            limit ${HORIZON_LIMITS.page_size + 1}`,
          [scanId, at?.[1] ?? null, at?.[2] ?? null],
        );
        const page = rows.slice(0, HORIZON_LIMITS.page_size);
        const last = page.at(-1);
        return done({
          items: page.map(itemView),
          next_cursor: rows.length > page.length && last ? `${last.published_at}_${last.id}` : null,
        });
      }),
  };
}

export type Horizon = ReturnType<typeof createHorizon>;
