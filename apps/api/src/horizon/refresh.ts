import { randomUUID } from "node:crypto";
import { HORIZON_SOURCES, type HorizonSource } from "@legallabs/contracts";
import {
  type ScanCandidate,
  type ScanCursor,
  type Scanners,
  scanCursor,
} from "@legallabs/knowledge";
import { type Gateway, GatewayError } from "@legallabs/model-gateway";
import type pg from "pg";
import type { Client, Principal } from "../auth/auth.js";
import { asApp, asWorker, RLS_REFUSED } from "../db.js";
import { describeError } from "../log-error.js";
import { audit, type Db, enabled, mayRun } from "./horizon.js";
import {
  type Assessment,
  BATCH,
  NOT_ASSESSED,
  parse,
  prompt,
  SYSTEM,
  type Wanted,
} from "./relevance.js";

// The hourly refresh. A due-queue in Postgres hands out one scan at a time under a lease; the
// scan is then worked as its owner, with what they may do asked again before every model call
// and every write. A source is asked only for what is new since a date: nothing a person typed
// ever leaves for it.

export interface HorizonRefreshOptions {
  gateway: Gateway;
  scanners: Scanners;
  /** Model spend for one refresh of one scan. */
  maxCostUsd?: number;
  /** Model spend for a whole workspace in 24 hours. */
  dailyCostUsd?: number;
  intervalMs?: number;
  /** Scans looked at in one pass. */
  batch?: number;
  leaseSeconds?: number;
  now?: () => Date;
  print?: (line: string) => void;
}

const HOUR = 3_600_000;
const MAX_OUTPUT = 3_000;
// Unreadable answers for the same items before they are kept unassessed, so none blocks a scan.
const BAD_ANSWERS = 3;
const NO_CLIENT: Client = { ip: null, userAgent: null };

interface Claim {
  id: string;
  workspace_id: string;
  owner_id: string;
}

interface Scan extends Wanted {
  sources: HorizonSource[];
  from_date: string;
}

interface State {
  cursor: ScanCursor;
  bad: number;
}

/** The owner can no longer run the scan: the whole refresh ends and the scan stops. */
class Lost extends Error {}
/** Scanning was turned off, or the scan was deleted, while it was being worked. */
class Gone extends Error {}

/** The scan as its owner may run it right now, or the reason they may not. */
async function current(db: Db, id: string): Promise<Scan> {
  // A person who is no longer an active member reads nothing, settings included.
  const { rows: member } = await db.query<{ ok: boolean }>("select apps.horizon_member() ok");
  if (!member[0]?.ok) throw new Lost();
  if (!(await enabled(db))) throw new Gone();
  if (!(await mayRun(db))) throw new Lost();
  const { rows } = await db.query<Scan & { stopped: boolean }>(
    `select purpose, jurisdictions, industries, topics, sources,
        to_char(from_date, 'YYYY-MM-DD') from_date, stopped
       from apps.horizon_scan where id = $1`,
    [id],
  );
  if (!rows[0] || rows[0].stopped) throw new Gone();
  return rows[0];
}

export function createHorizonRefresh(pool: pg.Pool, options: HorizonRefreshOptions) {
  const { gateway, scanners } = options;
  const maxCost = options.maxCostUsd ?? 0.5;
  const dailyCost = options.dailyCostUsd ?? 5;
  const leaseSeconds = options.leaseSeconds ?? 600;
  const now = options.now ?? (() => new Date());
  const print = options.print ?? (() => {});

  const check = (p: Principal, id: string) => asApp(pool, p, (db) => current(db, id));

  const lease = (p: Principal, id: string, seconds: number) =>
    asApp(pool, p, (db) =>
      db.query("update apps.horizon_scan set next_refresh_at = $2 where id = $1", [
        id,
        new Date(now().getTime() + seconds * 1000),
      ]),
    );

  const stateOf = (p: Principal, id: string, source: string, from: string) =>
    asApp(pool, p, async (db): Promise<State> => {
      const { rows } = await db.query<{ cursor: Record<string, unknown> }>(
        "select cursor from apps.horizon_cursor where scan_id = $1 and source_id = $2",
        [id, source],
      );
      const stored = rows[0]?.cursor;
      return {
        cursor: scanCursor.safeParse(stored).data ?? { since: from },
        bad: Number(stored?.bad ?? 0),
      };
    });

  const keep = (db: Db, p: Principal, id: string, source: string, state: State) =>
    db.query(
      `insert into apps.horizon_cursor (workspace_id, scan_id, source_id, cursor, last_ok_at)
       values ($1, $2, $3, $4, $5)
       on conflict (scan_id, source_id)
       do update set cursor = $4, last_ok_at = $5, failures = 0, last_error = null`,
      [p.workspaceId, id, source, JSON.stringify({ ...state.cursor, bad: state.bad }), now()],
    );

  const failed = (p: Principal, id: string, source: string, state: State, why: string) =>
    asApp(pool, p, async (db) => {
      const { rows } = await db.query<{ failures: number }>(
        `insert into apps.horizon_cursor as c
           (workspace_id, scan_id, source_id, cursor, failures, last_error)
         values ($1, $2, $3, $4, 1, $5)
         on conflict (scan_id, source_id)
         do update set failures = c.failures + 1, last_error = $5
         returning failures`,
        [
          p.workspaceId,
          id,
          source,
          JSON.stringify({ ...state.cursor, bad: state.bad }),
          why.slice(0, 40),
        ],
      );
      // Recorded as it turns degraded, not on every hour it stays so.
      if (rows[0]?.failures === 3) {
        await audit(db, p, "horizon.scan.degraded", "scan", id, { source }, NO_CLIENT);
      }
    });

  const spentToday = async (db: Db) =>
    Number(
      (
        await db.query<{ usd: string }>("select apps.horizon_spent($1) usd", [
          new Date(now().getTime() - 24 * HOUR),
        ])
      ).rows[0]?.usd ?? 0,
    );

  /** What the scan does not hold yet. */
  const unseen = (p: Principal, id: string, found: ScanCandidate[]) =>
    asApp(pool, p, async (db) => {
      const byUrl = new Map(found.map((item) => [item.url, item]));
      const { rows } = await db.query<{ url: string }>(
        "select url from apps.horizon_item where scan_id = $1 and url = any ($2)",
        [id, [...byUrl.keys()]],
      );
      for (const row of rows) byUrl.delete(row.url);
      return [...byUrl.values()];
    });

  async function save(
    p: Principal,
    id: string,
    source: HorizonSource,
    graded: [ScanCandidate, Assessment][],
  ) {
    const jurisdiction = HORIZON_SOURCES.find((s) => s.id === source)?.jurisdiction;
    await asApp(pool, p, async (db) => {
      // Asked again in the writing transaction: the model call took time.
      await current(db, id);
      for (const [item, grade] of graded) {
        await db.query(
          `insert into apps.horizon_item (workspace_id, scan_id, source_id, external_id, url,
             title, summary, doc_type, jurisdiction, published_on, relevance, explanation,
             topics, industries)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           on conflict (scan_id, url) do nothing`,
          [
            p.workspaceId,
            id,
            source,
            item.externalId,
            item.url,
            item.title,
            item.summary,
            item.docType,
            jurisdiction,
            item.publishedOn,
            grade.relevance,
            grade.explanation,
            grade.topics,
            grade.industries,
          ],
        );
      }
    });
  }

  /** One batch through the model. Null: no usable answer; "stop": nothing more this time. */
  async function grade(
    p: Principal,
    wanted: Wanted,
    items: ScanCandidate[],
    spend: { usd: number },
  ): Promise<Map<number, Assessment> | null | "stop"> {
    if (spend.usd >= maxCost || (await asApp(pool, p, spentToday)) >= dailyCost) return "stop";
    let output: string;
    try {
      const result = await gateway.call({
        task_class: "read_extract",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt(wanted, items) },
        ],
        budget: { max_output: MAX_OUTPUT, max_cost_usd: 0.1 },
        routing: { workspace: p.workspaceId },
        trace: randomUUID(),
      });
      output = result.output;
      spend.usd += result.cost_usd;
      // Spent is spent, whatever becomes of the answer.
      await asApp(pool, p, (db) =>
        db.query(
          "insert into apps.horizon_spend (workspace_id, owner_id, usd, at) values ($1, $2, $3, $4)",
          [p.workspaceId, p.userId, result.cost_usd, now()],
        ),
      );
    } catch (err) {
      if (err instanceof GatewayError) return "stop";
      throw err;
    }
    return parse(output, wanted);
  }

  async function source(p: Principal, claim: Claim, name: HorizonSource, spend: { usd: number }) {
    const scan = await check(p, claim.id);
    const state = await stateOf(p, claim.id, name, scan.from_date);
    await lease(p, claim.id, leaseSeconds);
    let found: Awaited<ReturnType<Scanners[HorizonSource]>>;
    try {
      found = await scanners[name](state.cursor);
    } catch (err) {
      print(`horizon ${claim.id}: ${name} failed: ${(err as Error).constructor.name}`);
      await failed(p, claim.id, name, state, (err as Error).constructor.name);
      return;
    }
    const fresh = await unseen(
      p,
      claim.id,
      found.items.filter((item) => item.publishedOn >= scan.from_date),
    );
    let bad = state.bad;
    let complete = true;
    for (let at = 0; at < fresh.length; at += BATCH) {
      const items = fresh.slice(at, at + BATCH);
      // What the owner may do, and what the scan now asks for, right before each call.
      const wanted = await check(p, claim.id);
      await lease(p, claim.id, leaseSeconds);
      const answer = await grade(p, wanted, items, spend);
      if (answer === "stop") {
        complete = false;
        break;
      }
      if (!answer && ++bad < BAD_ANSWERS) {
        complete = false;
        break;
      }
      bad = 0;
      await save(
        p,
        claim.id,
        name,
        items.map((item, i) => [item, answer?.get(i + 1) ?? NOT_ASSESSED]),
      );
    }
    // The cursor only moves once everything up to it is held.
    await asApp(pool, p, (db) =>
      keep(db, p, claim.id, name, { cursor: complete ? found.cursor : state.cursor, bad }),
    );
  }

  async function refresh(claim: Claim) {
    const p: Principal = {
      sessionId: "horizon",
      userId: claim.owner_id,
      workspaceId: claim.workspace_id,
    };
    try {
      const scan = await check(p, claim.id);
      const spend = { usd: 0 };
      for (const name of scan.sources) await source(p, claim, name, spend);
      await asApp(pool, p, (db) =>
        db.query(
          "update apps.horizon_scan set last_refresh_at = $2, next_refresh_at = $3 where id = $1",
          [claim.id, now(), new Date(now().getTime() + HOUR)],
        ),
      );
    } catch (err) {
      if (err instanceof Lost || (err as { code?: string }).code === RLS_REFUSED) {
        await asWorker(pool, (w) => w.query("select apps.stop_horizon_scan($1)", [claim.id]));
      } else if (!(err instanceof Gone)) {
        // Left for the lease to run out; a database error names no values here.
        print(`horizon ${claim.id} failed: ${describeError(err)}`);
      }
    }
  }

  /** Refreshes what is due; `workspaceId` keeps tests to their own. */
  async function tick(workspaceId?: string) {
    for (let n = 0; n < (options.batch ?? 5); n++) {
      const claim = await asWorker(
        pool,
        async (w) =>
          (
            await w.query<Claim>("select * from apps.claim_horizon_scan($1, $2, $3)", [
              now(),
              leaseSeconds,
              workspaceId ?? null,
            ])
          ).rows[0],
      );
      if (!claim) return;
      await refresh(claim);
    }
  }

  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  const guarded = () => {
    running ??= tick()
      .catch((err) => print(`horizon tick failed: ${(err as Error).constructor.name}`))
      .finally(() => {
        running = null;
      });
    return running;
  };

  return {
    tick,
    start() {
      timer ??= setInterval(() => void guarded(), options.intervalMs ?? 60_000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}

export type HorizonRefresh = ReturnType<typeof createHorizonRefresh>;
