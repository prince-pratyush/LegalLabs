import { randomUUID } from "node:crypto";
import {
  FACT_LIMITS,
  type FactExtraction,
  type FactExtractionState,
  type FactExtractRequest,
  type FactSkipReason,
} from "@legallabs/contracts";
import { type Gateway, GatewayError } from "@legallabs/model-gateway";
import type pg from "pg";
import type { z } from "zod";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { trackUsage } from "../command-center/record.js";
import { asApp, asWorker, RLS_REFUSED } from "../db.js";
import { describeError } from "../log-error.js";
import type { RunLog } from "../runs/log.js";
import {
  type Db,
  FactRefused,
  type FactResult,
  factTrail,
  inFactSpace,
  insertFact,
  type LocatedCitation,
  locateOnPage,
  spaceVersion,
} from "./facts.js";
import { type Page, parseRead, READ_SYSTEM, type ReadFact, readPrompt, windows } from "./read.js";

// Reads chosen documents into a Space's fact table. One document at a time, each as the person
// who asked and under what they can open at that moment. A quote the verifier can't find on its
// page is counted and thrown away, and a page not read is never counted as read.

/** Takes asks from the caller's model budget; returns seconds to wait, or 0. */
type Charge = (asks: number) => number;

export interface FactExtractions {
  extract(
    p: Principal,
    spaceId: string,
    input: z.output<typeof FactExtractRequest>,
    charge: Charge,
    client: Client,
  ): Promise<FactResult<{ run_id: string; documents_total: number }>>;
  get(p: Principal, spaceId: string, runId: string): Promise<FactResult<FactExtraction>>;
  /** The caller's latest extractions in the Space, newest first. */
  list(p: Principal, spaceId: string): Promise<FactResult<FactExtraction[]>>;
  /** Moves every due extraction on; `workspaceId` keeps tests to their own. */
  tick(workspaceId?: string): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export interface FactExtractionOptions {
  gateway: Gateway;
  log: RunLog;
  /** Spend per extraction; what is left unread then is listed as not read. */
  maxCostUsd?: number;
  maxDocuments?: number;
  /** Characters of pages sent in one model call, at most. */
  windowChars?: number;
  intervalMs?: number;
  /** Extractions looked at in one pass. */
  batch?: number;
  /** How long one worker holds an extraction before another may take it. */
  leaseSeconds?: number;
  retrySeconds?: number;
  print?: (line: string) => void;
}

const WINDOW_CHARS = 12_000;
const MAX_OUTPUT = 4_000;
const CHARS_PER_TOKEN = 3;
const MAX_WINDOWS = 40;
const MAX_ATTEMPTS = 2;
// Documents read for one extraction before another gets a turn.
const DOCUMENTS_PER_TURN = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_CLIENT: Client = { ip: null, userAgent: null };

interface Claim {
  id: string;
  workspace_id: string;
  requested_by: string;
  space_id: string;
}

interface Pending {
  document_id: string;
  document_version_id: string;
  attempts: number;
}

interface Outcome {
  state: "read" | "partial" | "failed";
  reason: FactSkipReason | null;
  pagesRead: number;
  pagesTotal: number;
  facts: { read: ReadFact; citation: LocatedCitation }[];
  unverified: number;
  invalid: number;
}

const audit = (
  db: Db,
  p: Principal,
  action: string,
  runId: string,
  details: object,
  client: Client,
) =>
  db.query("select admin.append_audit_event($1, 'user', $2, 'run', $3, $4, $5, $6)", [
    action,
    p.userId,
    runId,
    JSON.stringify(details),
    client.ip,
    uaHash(client),
  ]);

const fold = (name: string) => name.toLowerCase();

/** "J. Smith" could be any J Smith already in the table. */
const INITIAL = /^(\p{L})\.?\s+(\p{L}[\p{L}'-]+)$/u;

/**
 * Finds the name in the Space's registry, as far as the caller can see it, or adds it. Names the
 * model read are never offered back to it, so nothing from one file leaks into another's read.
 */
async function entityFor(
  db: Db,
  p: Principal,
  spaceId: string,
  entity: { name: string; kind: string },
) {
  const { rows } = await db.query<{ id: string; provisional: boolean }>(
    `select id, provisional from apps.entity
      where space_id = $1
        and (lower(canonical_name) = $2
             or (origin = 'manual'
                 and exists (select 1 from unnest(aliases) a where lower(a) = $2)))
      order by provisional, id limit 3`,
    [spaceId, fold(entity.name)],
  );
  const sure = rows.filter((r) => !r.provisional);
  if (sure.length === 1) return sure[0]?.id as string;
  const held = rows.find((r) => r.provisional);
  if (held) return held.id;
  let ambiguous = sure.length > 1;
  const initial = INITIAL.exec(entity.name);
  if (!ambiguous && sure.length === 0 && initial?.[1] && initial[2]) {
    const { rowCount } = await db.query(
      `select 1 from apps.entity
        where space_id = $1 and kind = 'person'
          and left(lower(canonical_name), 1) = $2
          and lower(canonical_name) like '% ' || $3
          and lower(canonical_name) <> $4 limit 1`,
      [spaceId, fold(initial[1]), fold(initial[2]).replace(/[\\%_]/g, "\\$&"), fold(entity.name)],
    );
    ambiguous = rowCount === 1;
  }
  // Without `returning`: the name is only visible once a fact links it.
  const id = (await db.query<{ id: string }>("select core.uuid7() id")).rows[0]?.id as string;
  await db.query(
    `insert into apps.entity (id, workspace_id, space_id, kind, canonical_name, origin,
       provisional, created_by)
     values ($1, $2, $3, $4, $5, 'extracted', $6, $7)`,
    [id, p.workspaceId, spaceId, entity.kind, entity.name, ambiguous, p.userId],
  );
  return id;
}

async function issueFor(db: Db, p: Principal, spaceId: string, name: string, only: string[]) {
  const { rows } = await db.query<{ id: string }>(
    `select id from apps.issue
      where space_id = $1 and lower(name) = $2
        and (cardinality($3::uuid[]) = 0 or id = any ($3))
      order by (origin = 'manual') desc, id limit 1`,
    [spaceId, fold(name), only],
  );
  if (rows[0]) return rows[0].id;
  // Asked for particular issues: nothing else is proposed.
  if (only.length) return null;
  const id = (await db.query<{ id: string }>("select core.uuid7() id")).rows[0]?.id as string;
  await db.query(
    `insert into apps.issue (id, workspace_id, space_id, name, origin, created_by)
     values ($1, $2, $3, $4, 'extracted', $5)`,
    [id, p.workspaceId, spaceId, name, p.userId],
  );
  return id;
}

const COUNTS = `x.id run_id, x.space_id, x.state, x.failure, x.facts_found, x.rejected_unverified,
  x.rejected_invalid, x.cost_usd::float8 cost_usd, x.created_at, x.finished_at,
  count(d.*)::int documents_total,
  count(*) filter (where d.state = 'read')::int documents_read,
  count(*) filter (where d.state = 'partial')::int documents_partial,
  count(*) filter (where d.state = 'failed')::int documents_failed,
  count(*) filter (where d.state = 'pending')::int documents_pending`;
const FROM = `apps.fact_extraction x
  left join apps.fact_extraction_document d on d.extraction_id = x.id`;

type ViewRow = Omit<FactExtraction, "created_at" | "finished_at" | "complete" | "documents"> & {
  created_at: Date;
  finished_at: Date | null;
};

const view = (row: ViewRow, documents: FactExtraction["documents"]): FactExtraction => ({
  ...row,
  // Complete means every chosen file was read to its last page.
  complete: row.state === "done" && row.documents_read === row.documents_total,
  documents,
  created_at: row.created_at.toISOString(),
  finished_at: row.finished_at?.toISOString() ?? null,
});

export function createFactExtractions(
  pool: pg.Pool,
  options: FactExtractionOptions,
): FactExtractions {
  const { gateway, log } = options;
  const maxCost = options.maxCostUsd ?? 2;
  const maxDocuments = options.maxDocuments ?? FACT_LIMITS.documents_per_run;
  const leaseSeconds = options.leaseSeconds ?? 300;
  const retrySeconds = options.retrySeconds ?? 60;
  const print = options.print ?? (() => {});

  const lease = (p: Principal, id: string, seconds: number) =>
    asApp(pool, p, (db) =>
      db.query(
        `update apps.fact_extraction set next_attempt_at = now() + make_interval(secs => $2)
          where id = $1`,
        [id, seconds],
      ),
    );

  const lost = (id: string) =>
    asWorker(pool, (w) => w.query("select apps.fail_fact_extraction($1)", [id]));

  const runStatus = (p: Principal, id: string) =>
    asApp(pool, p, async (db) => {
      const { rows } = await db.query<{ status: string }>(
        "select status from work.run where id = $1",
        [id],
      );
      return rows[0]?.status ?? null;
    });

  const counts = async (db: Db, id: string) =>
    (await db.query<ViewRow>(`select ${COUNTS} from ${FROM} where x.id = $1 group by x.id`, [id]))
      .rows[0];

  async function progress(p: Principal, id: string) {
    const row = await asApp(pool, p, (db) => counts(db, id));
    if (!row) return;
    await log.append(p, id, {
      type: "facts.extract_progress",
      documents_done: row.documents_total - row.documents_pending,
      documents_total: row.documents_total,
      facts_found: row.facts_found,
      rejected_unverified: row.rejected_unverified,
    });
  }

  /** Models the Space's matter and the document's matter both leave usable. */
  const excluded = (p: Principal, spaceId: string, documentId: string) =>
    asApp(pool, p, async (db) => {
      const { rows } = await db.query<{
        model_policy: { deny_providers?: string[]; deny_models?: string[] } | null;
      }>(
        `select m.model_policy from core.matter m
          where m.id in (select matter_id from work.space where id = $1
                         union select matter_id from content.document where id = $2)`,
        [spaceId, documentId],
      );
      const all = gateway.models("read_extract").map((m) => m.id);
      const exclude = all.filter((model) => {
        const [provider = "", ...name] = model.split("/");
        return rows.some(
          ({ model_policy: policy }) =>
            policy?.deny_providers?.includes(provider) ||
            policy?.deny_models?.includes(model) ||
            policy?.deny_models?.includes(name.join("/")),
        );
      });
      return { exclude, none: all.length > 0 && exclude.length === all.length };
    });

  /** The pages of a version the caller can still open in a vault shared with the Space. */
  const pagesOf = (p: Principal, spaceId: string, versionId: string) =>
    asApp(pool, p, async (db) => {
      if (!(await spaceVersion(db, spaceId, versionId))) return null;
      const { rows } = await db.query<Page>(
        "select page_no, text from content.page where version_id = $1 order by page_no",
        [versionId],
      );
      return rows;
    });

  /** Reads one document through the model. Null: no model just now, try the document later. */
  async function read(
    p: Principal,
    claim: Claim,
    doc: Pending,
    issues: { names: string[]; only: boolean },
    budget: number,
  ): Promise<Outcome | null> {
    const none: Outcome = {
      state: "failed",
      reason: null,
      pagesRead: 0,
      pagesTotal: 0,
      facts: [],
      unverified: 0,
      invalid: 0,
    };
    const pages = await pagesOf(p, claim.space_id, doc.document_version_id);
    if (!pages) return { ...none, reason: "ACCESS_LOST" };
    const text = pages.filter((page) => page.text.trim() !== "");
    // A page with no text (a scan nobody read) is a page not read.
    const blank = pages.length - text.length;
    const out: Outcome = { ...none, pagesTotal: pages.length };
    if (text.length === 0) return { ...out, reason: "NO_TEXT" };
    const policy = await excluded(p, claim.space_id, doc.document_id);
    if (policy.none) return { ...out, reason: "MODEL_NOT_ALLOWED" };
    const room = Math.min(
      options.windowChars ?? WINDOW_CHARS,
      (gateway.contextTokens("read_extract") - MAX_OUTPUT) * CHARS_PER_TOKEN -
        READ_SYSTEM.length -
        2_000,
    );
    const { groups, tooLong } = windows(text, room);
    let reason: FactSkipReason | null = blank ? "NO_TEXT" : tooLong.length ? "PAGE_TOO_LONG" : null;
    let spent = 0;
    for (const [index, group] of groups.entries()) {
      const stop = index >= MAX_WINDOWS ? "TOO_MANY_PAGES" : spent >= budget ? "COST_LIMIT" : null;
      if (stop) {
        reason = stop;
        break;
      }
      await lease(p, claim.id, leaseSeconds);
      let output: string;
      try {
        const result = await gateway.call({
          task_class: "read_extract",
          messages: [
            { role: "system", content: READ_SYSTEM },
            { role: "user", content: readPrompt(group, issues.names, issues.only) },
          ],
          budget: { max_output: MAX_OUTPUT, max_cost_usd: 0.1 },
          routing: { workspace: p.workspaceId },
          trace: randomUUID(),
          ...(policy.exclude.length ? { exclude: policy.exclude } : {}),
        });
        output = result.output;
        spent += result.cost_usd;
        // Spent is spent, whatever becomes of the answer.
        await asApp(pool, p, (db) =>
          db.query("update apps.fact_extraction set cost_usd = cost_usd + $2 where id = $1", [
            claim.id,
            result.cost_usd,
          ]),
        );
      } catch (err) {
        if (!(err instanceof GatewayError)) throw err;
        if (doc.attempts + 1 < MAX_ATTEMPTS) return null;
        reason = "MODEL_UNAVAILABLE";
        break;
      }
      const answer = parseRead(output);
      if (!answer) {
        reason = "BAD_OUTPUT";
        continue;
      }
      out.invalid += answer.invalid;
      if (answer.cut) reason = "TOO_MANY_FACTS";
      else out.pagesRead += group.length;
      for (const fact of answer.facts) {
        const page = group.find((g) => g.page_no === fact.page);
        const citation = page
          ? await locateOnPage(
              doc.document_version_id,
              doc.document_id,
              page.page_no,
              page.text,
              fact.quote,
            )
          : null;
        if (citation) out.facts.push({ read: fact, citation });
        else out.unverified += 1;
      }
    }
    out.reason = reason;
    out.state =
      out.pagesRead === pages.length && !reason
        ? "read"
        : out.pagesRead > 0 || out.facts.length > 0
          ? "partial"
          : "failed";
    if (out.state !== "read" && !out.reason) out.reason = "FAILED";
    return out;
  }

  /** Saves one document's facts and its outcome together, once. */
  const save = (p: Principal, claim: Claim, doc: Pending, out: Outcome, only: string[]) =>
    asApp(pool, p, async (db) => {
      const { rowCount } = await db.query(
        `select 1 from apps.fact_extraction_document d
           join work.run r on r.id = d.extraction_id and r.status = 'running'
          where d.extraction_id = $1 and d.document_id = $2 and d.state = 'pending'
          for update of d`,
        [claim.id, doc.document_id],
      );
      if (!rowCount) return;
      let stored = 0;
      for (const { read: fact, citation } of out.facts) {
        // The same words from the same place are already in the table: read once is enough.
        const { rowCount: there } = await db.query(
          `select 1 from apps.fact f join apps.fact_citation c on c.fact_id = f.id
            where f.space_id = $1 and c.document_version_id = $2 and c.page_no = $3
              and c.char_from = $4 and c.char_to = $5 and lower(f.text) = lower($6) limit 1`,
          [
            claim.space_id,
            citation.versionId,
            citation.page,
            citation.from,
            citation.to,
            fact.text,
          ],
        );
        if (there) continue;
        const entities = new Set<string>();
        for (const entity of fact.entities) {
          entities.add(await entityFor(db, p, claim.space_id, entity));
        }
        const issues = new Set<string>();
        for (const name of fact.issues) {
          const id = await issueFor(db, p, claim.space_id, name, only);
          if (id) issues.add(id);
        }
        // The insert links and the names go in one transaction with the fact.
        const id = await insertFact(db, p, {
          spaceId: claim.space_id,
          source: "extracted",
          text: fact.text,
          event_date: fact.event_date,
          event_date_end: fact.event_date_end,
          date_precision: fact.date_precision,
          citations: [citation],
          entities: [...entities].map((e) => ({ id: e, via: "extracted" })),
          issues: [...issues].map((i) => ({ id: i, via: "extracted" })),
        });
        await factTrail(db, p, claim.space_id, id, "extracted", { run_id: claim.id });
        stored += 1;
      }
      await db.query(
        `update apps.fact_extraction_document
            set state = $3, reason = $4, pages_total = $5, pages_read = $6, facts = $7,
                rejected = $8
          where extraction_id = $1 and document_id = $2`,
        [
          claim.id,
          doc.document_id,
          out.state,
          out.reason,
          out.pagesTotal,
          out.pagesRead,
          stored,
          out.unverified + out.invalid,
        ],
      );
      await db.query(
        `update apps.fact_extraction
            set facts_found = facts_found + $2, rejected_unverified = rejected_unverified + $3,
                rejected_invalid = rejected_invalid + $4
          where id = $1`,
        [claim.id, stored, out.unverified, out.invalid],
      );
    });

  /** Closes an extraction: done only if every file was read in full. */
  async function finish(p: Principal, claim: Claim, cancelled: boolean) {
    const closed = await asApp(pool, p, async (db) => {
      await db.query("select 1 from apps.fact_extraction where id = $1 for update", [claim.id]);
      const row = await counts(db, claim.id);
      if (!row || !["queued", "running"].includes(row.state)) return null;
      const state: FactExtractionState = cancelled
        ? "cancelled"
        : row.documents_read === row.documents_total
          ? "done"
          : row.documents_read + row.documents_partial > 0
            ? "partial"
            : "failed";
      await db.query(
        `update apps.fact_extraction set state = $2, finished_at = now() where id = $1`,
        [claim.id, state],
      );
      const numbers = {
        space_id: claim.space_id,
        documents: row.documents_total,
        documents_read: row.documents_read,
        facts: row.facts_found,
        rejected: row.rejected_unverified + row.rejected_invalid,
      };
      await factTrail(db, p, claim.space_id, null, `extraction_${state}`, {
        run_id: claim.id,
        ...numbers,
        space_id: undefined,
      });
      await audit(
        db,
        p,
        state === "cancelled"
          ? "facts.extraction_cancelled"
          : state === "failed"
            ? "facts.extraction_failed"
            : "facts.extracted",
        claim.id,
        numbers,
        NO_CLIENT,
      );
      if (!cancelled) {
        await db.query(
          "update work.run set status = $2, updated_at = now() where id = $1 and status = 'running'",
          [claim.id, state === "failed" ? "failed" : "done"],
        );
      }
      await trackUsage(db, {
        surface: "apps",
        action: "facts.extract",
        actionClass: "other",
        objectType: "space",
        objectId: claim.space_id,
        documentCount: row.documents_total,
        costUsd: row.cost_usd,
      });
      return state;
    });
    if (!closed || closed === "cancelled") return;
    await progress(p, claim.id);
    await log.append(p, claim.id, {
      type: "status",
      status: closed === "failed" ? "failed" : "done",
      ...(closed === "partial" ? { reason: "Not every file was read in full." } : {}),
    });
    log.release(claim.id);
  }

  async function step(claim: Claim) {
    const p: Principal = {
      sessionId: "facts-queue",
      userId: claim.requested_by,
      workspaceId: claim.workspace_id,
    };
    const found = await asApp(pool, p, async (db) => {
      const { rows } = await db.query<{ issue_ids: string[]; allowed: boolean }>(
        `select issue_ids, core.has_permission('threads.use') allowed
           from apps.fact_extraction where id = $1`,
        [claim.id],
      );
      return rows[0];
    });
    if (!found?.allowed) return void (await lost(claim.id));
    for (let turn = 0; turn < DOCUMENTS_PER_TURN; turn++) {
      const status = await runStatus(p, claim.id);
      if (status === "cancelled") return finish(p, claim, true);
      if (status !== "running") return void (await lost(claim.id));
      const next = await asApp(pool, p, async (db) => {
        const { rows } = await db.query<Pending & { cost: number }>(
          `select d.document_id, d.document_version_id, d.attempts, x.cost_usd::float8 cost
             from apps.fact_extraction_document d
             join apps.fact_extraction x on x.id = d.extraction_id
            where d.extraction_id = $1 and d.state = 'pending'
            order by d.position limit 1`,
          [claim.id],
        );
        const doc = rows[0];
        if (!doc) return null;
        // Counted before the model is asked, so a crash can't pay for one file without end.
        await db.query(
          `update apps.fact_extraction_document set attempts = attempts + 1
            where extraction_id = $1 and document_id = $2`,
          [claim.id, doc.document_id],
        );
        await db.query(
          "update apps.fact_extraction set state = 'running' where id = $1 and state = 'queued'",
          [claim.id],
        );
        const { rows: issues } = await db.query<{ name: string }>(
          `select name from apps.issue
            where space_id = $1 and origin = 'manual'
              and (cardinality($2::uuid[]) = 0 or id = any ($2))
            order by lower(name) limit 50`,
          [claim.space_id, found.issue_ids],
        );
        return { doc, issues: issues.map((i) => i.name) };
      });
      if (!next) return finish(p, claim, false);
      const { doc } = next;
      const fail = (reason: FactSkipReason) =>
        asApp(pool, p, (db) =>
          db.query(
            `update apps.fact_extraction_document set state = 'failed', reason = $3
              where extraction_id = $1 and document_id = $2 and state = 'pending'`,
            [claim.id, doc.document_id, reason],
          ),
        );
      if (doc.cost >= maxCost) await fail("COST_LIMIT");
      else if (doc.attempts >= MAX_ATTEMPTS) await fail("FAILED");
      else {
        try {
          const out = await read(
            p,
            claim,
            doc,
            { names: next.issues, only: found.issue_ids.length > 0 },
            maxCost - doc.cost,
          );
          if (!out) return void (await lease(p, claim.id, retrySeconds));
          await save(p, claim, doc, out, found.issue_ids);
        } catch (err) {
          // Access taken away between reading and saving: nothing of it is kept.
          if ((err as { code?: string }).code !== RLS_REFUSED) throw err;
          await fail("ACCESS_LOST");
        }
      }
      await progress(p, claim.id);
    }
    // More to read: due again at once, behind whoever else is waiting.
    await lease(p, claim.id, 0);
  }

  async function tick(workspaceId?: string) {
    const seen: string[] = [];
    while (seen.length < (options.batch ?? 5)) {
      const claim = await asWorker(
        pool,
        async (w) =>
          (
            await w.query<Claim>("select * from apps.claim_fact_extraction($1, $2, $3)", [
              leaseSeconds,
              workspaceId ?? null,
              seen,
            ])
          ).rows[0],
      );
      if (!claim) return;
      seen.push(claim.id);
      try {
        await step(claim);
      } catch (err) {
        // Its lease runs out and it is tried again. No document text reaches the log.
        print(`fact extraction ${claim.id} failed to advance: ${describeError(err)}`);
      }
    }
  }

  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  const scheduled = () => {
    running ??= tick()
      .catch((err) => print(`fact extraction queue failed: ${describeError(err)}`))
      .finally(() => {
        running = null;
      });
  };

  async function documentsOf(db: Db, id: string) {
    // The name only while the caller can still open the file.
    const { rows } = await db.query<FactExtraction["documents"][number]>(
      `select d.document_id, doc.name, d.state, d.reason, d.pages_total, d.pages_read, d.facts,
              d.rejected
         from apps.fact_extraction_document d
         left join content.document doc on doc.id = d.document_id
        where d.extraction_id = $1 order by d.position`,
      [id],
    );
    return rows;
  }

  return {
    async extract(p, spaceId, input, charge, client) {
      const result = await inFactSpace(pool, p, spaceId, async (db) => {
        const { rows: allowed } = await db.query<{ ok: boolean }>(
          "select core.has_permission('threads.use') ok",
        );
        if (!allowed[0]?.ok) throw new FactRefused("FORBIDDEN");
        // One start at a time per person, so the limit on running extractions holds.
        await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `apps.fact_extraction ${p.userId}`,
        ]);
        const { rows: active } = await db.query<{ n: number }>(
          `select count(*)::int n from apps.fact_extraction
            where requested_by = $1 and state in ('queued', 'running')`,
          [p.userId],
        );
        if ((active[0]?.n ?? 0) >= FACT_LIMITS.active_runs) throw new FactRefused("TOO_MANY_RUNS");
        const issueIds = input.issue_ids ?? [];
        if (issueIds.length) {
          const { rows } = await db.query<{ n: number }>(
            "select count(*)::int n from apps.issue where space_id = $1 and id = any ($2::uuid[])",
            [spaceId, issueIds],
          );
          if (rows[0]?.n !== issueIds.length) throw new FactRefused("UNKNOWN_ISSUE");
        }
        // Only files the caller can open, in vaults shared with the Space: never the Inbox.
        const { rows: documents } = await db.query<{
          id: string;
          version_id: string | null;
          status: string | null;
        }>(
          `with recursive under as (
             select id from content.folder
              where id = $4 and vault_id = $3 and deleted_at is null
             union all
             select f.id from content.folder f join under u on f.parent_id = u.id
              where f.deleted_at is null
           )
           select d.id, v.id version_id, j.status
             from content.document d
             join work.space_resource r on r.resource_type = 'vault' and r.resource_id = d.vault_id
                                       and r.space_id = $1 and r.suspended_reason is null
             left join lateral (select x.id from content.document_version x
                                 where x.document_id = d.id order by x.version_no desc limit 1) v
               on true
             left join content.ingest_job j on j.version_id = v.id
            where ($2::uuid[] is null or d.id = any ($2))
              and ($3::uuid is null or d.vault_id = $3)
              and ($4::uuid is null or d.folder_id in (select id from under))
            order by d.id limit $5`,
          [
            spaceId,
            input.document_ids ?? null,
            input.vault_id ?? null,
            input.folder_id ?? null,
            maxDocuments + 1,
          ],
        );
        // Chosen files are all there or the request is refused, so none is dropped quietly.
        if (
          documents.length === 0 ||
          (input.document_ids &&
            documents.length < Math.min(input.document_ids.length, maxDocuments))
        ) {
          throw new FactRefused("DOCUMENT_NOT_FOUND");
        }
        if (documents.length > maxDocuments || (input.document_ids?.length ?? 0) > maxDocuments) {
          throw new FactRefused("TOO_MANY_DOCUMENTS");
        }
        const wait = charge(Math.ceil(documents.length / FACT_LIMITS.documents_per_ask));
        if (wait > 0) throw new FactRefused("TOO_MANY_REQUESTS");
        const { rows: run } = await db.query<{ id: string }>(
          `insert into work.run (workspace_id, owner_id, kind, status, space_id, matter_id)
           select $1, $2, 'fact_extraction', 'running', s.id, s.matter_id
             from work.space s where s.id = $3 returning id`,
          [p.workspaceId, p.userId, spaceId],
        );
        const runId = run[0]?.id as string;
        await db.query(
          `insert into apps.fact_extraction (id, workspace_id, space_id, requested_by, issue_ids)
           values ($1, $2, $3, $4, $5)`,
          [runId, p.workspaceId, spaceId, p.userId, issueIds],
        );
        for (const [position, d] of documents.entries()) {
          const reason: FactSkipReason | null = !d.version_id
            ? "NO_TEXT"
            : d.status === "failed"
              ? "PARSE_FAILED"
              : d.status !== "indexed"
                ? "NOT_READY"
                : null;
          await db.query(
            `insert into apps.fact_extraction_document
               (extraction_id, workspace_id, document_id, document_version_id, position, state,
                reason)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [
              runId,
              p.workspaceId,
              d.id,
              d.version_id,
              position,
              reason ? "failed" : "pending",
              reason,
            ],
          );
        }
        await factTrail(db, p, spaceId, null, "extraction_started", {
          run_id: runId,
          documents: documents.length,
        });
        await audit(
          db,
          p,
          "facts.extraction_started",
          runId,
          { space_id: spaceId, documents: documents.length },
          client,
        );
        return { run_id: runId, documents_total: documents.length };
      });
      if (result.ok) await progress(p, result.value.run_id);
      return result;
    },

    async get(p, spaceId, runId) {
      return inFactSpace(pool, p, spaceId, async (db) => {
        const row = UUID.test(runId) ? await counts(db, runId) : undefined;
        if (!row || row.space_id !== spaceId) throw new FactRefused("NOT_FOUND");
        return view(row, await documentsOf(db, runId));
      });
    },

    async list(p, spaceId) {
      return inFactSpace(pool, p, spaceId, async (db) => {
        const { rows } = await db.query<ViewRow>(
          `select ${COUNTS} from ${FROM} where x.space_id = $1 group by x.id
            order by x.created_at desc, x.id desc limit 10`,
          [spaceId],
        );
        return rows.map((row) => view(row, []));
      });
    },

    tick,

    start() {
      timer ??= setInterval(scheduled, options.intervalMs ?? 2_000);
      timer.unref?.();
    },

    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
