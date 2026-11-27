import {
  type AssignmentRule,
  CI_LIMITS,
  type CiAgent,
  type CiAgentCreate,
  type CiAgentPatch,
  type CiAgentStatus,
  type CiDashboard,
  type CiFields,
  CiResult,
  type CiReview,
  type CiReviewCreate,
  type CiReviewStatus,
  type CiThresholds,
  ciAssignmentOrder,
  ciStatus,
  ciSummary,
  type Review,
  ReviewRequest,
} from "@legallabs/contracts";
import type pg from "pg";
import type { z } from "zod";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { trackOutcome, trackUsage } from "../command-center/record.js";
import { asApp, asWorker, type Identity, RLS_REFUSED } from "../db.js";
import { describeError } from "../log-error.js";
import { type Notifier, noNotifier } from "../notifications/notify.js";
import { asksFor, type ReviewFailure, type Reviews } from "../reviews/reviews.js";
import { versionMeta } from "../reviews/source.js";

type Db = pg.PoolClient;
type AgentIn = z.output<typeof CiAgentCreate>;
type PatchIn = z.output<typeof CiAgentPatch>;
type ReviewIn = z.output<typeof CiReviewCreate>;
/** Takes asks from the caller's model budget; returns seconds to wait, or 0. */
type Charge = (asks: number) => number;

export type CiFailure =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "NOT_PUBLISHED"
  | "AGENT_NOT_LIVE"
  | "ASSIGNEE_NOT_ALLOWED"
  | "WRONG_STATE"
  | "TOO_MANY_REQUESTS"
  | "BAD_CURSOR";

export type Result<T> = { ok: true; value: T } | { ok: false; reason: CiFailure };

export interface CiFilter {
  status?: CiReviewStatus | undefined;
  assigneeId?: string | undefined;
  agentId?: string | undefined;
  /** Any part of the counterparty's name. */
  counterparty?: string | undefined;
  /** Last changed at or after `from` and before `to`. */
  from?: string | undefined;
  to?: string | undefined;
  cursor?: string | undefined;
}

export interface Ci {
  createAgent(principal: Principal, input: AgentIn, client: Client): Promise<Result<CiAgent>>;
  listAgents(principal: Principal): Promise<CiAgent[]>;
  getAgent(principal: Principal, id: string): Promise<CiAgent | null>;
  /** Names of the people and groups the agent's assignment rules point at, by id. */
  assigneeNames(principal: Principal, agent: CiAgent): Promise<Record<string, string>>;
  dashboard(principal: Principal, since?: string): Promise<CiDashboard>;
  patchAgent(
    principal: Principal,
    id: string,
    patch: PatchIn,
    client: Client,
  ): Promise<Result<CiAgent>>;
  setAgentStatus(
    principal: Principal,
    id: string,
    status: Exclude<CiAgentStatus, "draft">,
    client: Client,
  ): Promise<Result<CiAgent>>;
  createReview(
    principal: Principal,
    input: ReviewIn,
    charge: Charge,
    client: Client,
  ): Promise<Result<{ review_id: string }>>;
  list(
    principal: Principal,
    filter: CiFilter,
  ): Promise<Result<{ reviews: CiReview[]; next_cursor: string | null }>>;
  get(principal: Principal, id: string): Promise<CiReview | null>;
  assign(
    principal: Principal,
    id: string,
    assigneeId: string,
    client: Client,
  ): Promise<Result<CiReview>>;
  markDone(principal: Principal, id: string, client: Client): Promise<Result<CiReview>>;
  rerun(
    principal: Principal,
    id: string,
    charge: Charge,
    client: Client,
  ): Promise<Result<{ review_id: string }>>;
  /** Moves every due review one step along; `workspaceId` keeps tests to their own. */
  tick(workspaceId?: string): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export interface CiOptions {
  /** Reviews are run by the playbook review service, with its per-person and spend caps. */
  reviews: Pick<Reviews, "start" | "get">;
  notifier?: Notifier;
  intervalMs?: number;
  batch?: number;
  /** How long one worker holds a row before another may take it. */
  leaseSeconds?: number;
  /** Wait before trying again when a cap or a busy model turned a review away. */
  retrySeconds?: number;
  /** Wait between looks at a running review. */
  pollSeconds?: number;
  /** A review still unfinished after this long is given up on. */
  staleMinutes?: number;
  pageSize?: number;
  log?: (line: string) => void;
}

// Refusals that pass on their own; anything else fails the contract with its code.
const TRY_AGAIN = new Set<ReviewFailure>([
  "TOO_MANY_REVIEWS",
  "TOO_MANY_REQUESTS",
  "MODEL_UNAVAILABLE",
  "NOT_READY",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?\+\d\d(?::\d\d)?)\|([0-9a-f-]{36})$/;
// The queue is the server acting for the owner, so there is no caller to record.
const NO_CLIENT: Client = { ip: null, userAgent: null };

class Refused extends Error {
  constructor(readonly reason: CiFailure) {
    super(reason);
  }
}
const refuse = (reason: CiFailure): never => {
  throw new Refused(reason);
};
/** Another worker took the contract first. */
class Taken extends Error {}

interface AgentRow extends Omit<CiAgent, "created_at" | "updated_at"> {
  created_at: Date;
  updated_at: Date;
}

const AGENT_COLUMNS = `id, name, contract_type, playbook_id, party, paper, assignment, thresholds,
  status, created_at, updated_at`;

const toAgent = (row: AgentRow): CiAgent => ({
  ...row,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
});

interface ReviewRow
  extends Omit<CiReview, "created_at" | "updated_at" | "done_at" | "assignee_name"> {
  owner_id: string;
  playbook_id: string;
  matter_id: string | null;
  assignee_name: string | null;
  fields: CiFields;
  started_at: Date | null;
  created_at: Date;
  updated_at: Date;
  done_at: Date | null;
  sort_key: string;
}

const REVIEW_COLUMNS = `r.id, r.ci_agent_id agent_id, r.agent_name, r.owner_id, r.playbook_id,
  r.document_id, r.document_version_id, d.name document_name, d.matter_id, r.playbook_review_id,
  r.run_id, r.status, r.result,
  -- It names the playbook's rules, so it goes only to someone who can open the playbook.
  case when r.owner_id = core.current_user_id() or work.playbook_level(r.playbook_id) is not null
       then r.summary end summary,
  r.failure, r.assignee_id,
  nullif(coalesce(nullif(u.name, ''), u.email), '') assignee_name, r.counterparty, r.fields,
  r.source, r.started_at, r.created_at, r.updated_at, r.done_at, r.updated_at::text sort_key`;
const REVIEW_FROM = `apps.ci_contract_review r join content.document d on d.id = r.document_id
  left join core."user" u on u.id = r.assignee_id`;

const toReview = (row: ReviewRow): CiReview => ({
  id: row.id,
  agent_id: row.agent_id,
  agent_name: row.agent_name,
  document_id: row.document_id,
  document_version_id: row.document_version_id,
  document_name: row.document_name,
  playbook_review_id: row.playbook_review_id,
  run_id: row.run_id,
  status: row.status,
  result: row.result,
  summary: row.summary,
  failure: row.failure,
  assignee_id: row.assignee_id,
  assignee_name: row.assignee_name,
  counterparty: row.counterparty,
  source: row.source,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
  done_at: row.done_at?.toISOString() ?? null,
});

async function loadReview(db: Db, id: string): Promise<ReviewRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<ReviewRow>(
    `select ${REVIEW_COLUMNS} from ${REVIEW_FROM} where r.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function loadAgent(db: Db, id: string): Promise<AgentRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<AgentRow>(
    `select ${AGENT_COLUMNS} from apps.ci_review_agent where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

const audit = (
  db: Db,
  principal: Principal,
  action: string,
  type: "ci_agent" | "ci_review",
  id: string,
  details: object,
  client: Client,
) =>
  db.query("select admin.append_audit_event($1, 'user', $2, $3, $4, $5, $6, $7)", [
    action,
    principal.userId,
    type,
    id,
    JSON.stringify(details),
    client.ip,
    uaHash(client),
  ]);

const canBuild = async (db: Db) =>
  (
    await db.query<{ ok: boolean }>(
      `select core.has_permission('agents.build') and core.has_permission('playbooks.create') ok`,
    )
  ).rows[0]?.ok === true;

/** Fails unless the caller can open the playbook; says whether it is published. */
async function playbookState(db: Db, id: string) {
  const { rows } = await db.query<{ published: boolean; rules: number }>(
    `select p.published_version_id is not null published,
            coalesce(jsonb_array_length(v.rules), 0) rules
       from work.playbook p
       left join work.playbook_version v on v.id = p.published_version_id
      where p.id = $1 and work.playbook_level(p.id) is not null`,
    [id],
  );
  return rows[0] ?? refuse("NOT_FOUND");
}

export function createCi(pool: pg.Pool, options: CiOptions): Ci {
  const { reviews } = options;
  const notifier = options.notifier ?? noNotifier;
  const log = options.log ?? (() => {});
  const pageSize = options.pageSize ?? CI_LIMITS.page_size;
  const leaseSeconds = options.leaseSeconds ?? 120;
  const retrySeconds = options.retrySeconds ?? 30;
  const pollSeconds = options.pollSeconds ?? 5;
  const staleMs = (options.staleMinutes ?? 120) * 60_000;

  async function guarded<T>(principal: Principal, work: (db: Db) => Promise<T>) {
    try {
      return { ok: true as const, value: await asApp(pool, principal, work) };
    } catch (err) {
      if (err instanceof Refused) return { ok: false as const, reason: err.reason };
      if ((err as { code?: string }).code === RLS_REFUSED) {
        return { ok: false as const, reason: "FORBIDDEN" as const };
      }
      throw err;
    }
  }

  /**
   * Whether a person could open this contract and its review, asked as that person, so vault
   * access and walls answer exactly as they would for them.
   */
  const canTake = (
    workspaceId: string | null,
    userId: string,
    row: Pick<ReviewRow, "document_version_id" | "owner_id" | "playbook_id">,
  ) =>
    asApp(pool, { userId, workspaceId }, async (db) => {
      const { rowCount } = await db.query(
        `select 1 from core."user" u
          where u.id = $1 and u.kind = 'member' and u.status = 'active'
            and core.has_permission('threads.use')
            and exists (select 1 from content.document_version v where v.id = $2)
            and ($1 = $3 or work.playbook_level($4) is not null)`,
        [userId, row.document_version_id, row.owner_id, row.playbook_id],
      );
      return rowCount === 1;
    });

  const tell = (principal: Principal, row: ReviewRow, assignee: string, actorId: string | null) =>
    notifier.notify(principal, {
      kind: "ci.review_assigned",
      actorId,
      objectType: "ci_review",
      objectId: row.id,
      // The agent's name, not the file's: a title is also what email carries.
      objectTitle: row.agent_name,
      matterId: row.matter_id,
      people: { assignee },
      url: `#/ci/reviews/${row.id}`,
    });

  const later = (principal: Identity, id: string, seconds: number) =>
    asApp(pool, principal, (db) =>
      db.query(
        `update apps.ci_contract_review
            set next_attempt_at = now() + make_interval(secs => $2)
          where id = $1`,
        [id, seconds],
      ),
    );

  const failReview = (principal: Principal, id: string, failure: string) =>
    asApp(pool, principal, async (db) => {
      const { rowCount } = await db.query(
        `update apps.ci_contract_review set status = 'failed', failure = $2, updated_at = now()
          where id = $1 and status in ('queued', 'running')`,
        [id, failure],
      );
      if (rowCount) {
        await audit(db, principal, "ci.review.finished", "ci_review", id, { failure }, NO_CLIENT);
      }
    });

  /** Starts the playbook review for a queued contract, as the agent's owner. */
  async function begin(principal: Principal, row: ReviewRow) {
    const found = await asApp(pool, principal, async (db) =>
      (await canBuild(db)) ? loadAgent(db, row.agent_id) : null,
    );
    if (!found) return failReview(principal, row.id, "FORBIDDEN");
    let started: Awaited<ReturnType<Reviews["start"]>>;
    try {
      started = await reviews.start(
        principal,
        found.playbook_id,
        ReviewRequest.parse({
          document_version_id: row.document_version_id,
          party: found.party,
          paper: found.paper,
          surface: "web",
        }) as z.output<typeof ReviewRequest>,
        {
          draft: false,
          // Marked running as the review is created: neither a crash nor a second worker can
          // then pay for it twice.
          within: async (db, ids) => {
            const { rowCount } = await db.query(
              `update apps.ci_contract_review
                  set status = 'running', playbook_review_id = $2, run_id = $3,
                      playbook_id = $4, started_at = now(), updated_at = now(),
                      next_attempt_at = now() + make_interval(secs => $5)
                where id = $1 and status = 'queued'`,
              [row.id, ids.review_id, ids.run_id, found.playbook_id, pollSeconds],
            );
            if (!rowCount) throw new Taken();
          },
        },
        NO_CLIENT,
      );
    } catch (err) {
      if (err instanceof Taken) return;
      throw err;
    }
    if (!started.ok) {
      if (TRY_AGAIN.has(started.reason)) return later(principal, row.id, retrySeconds);
      return failReview(principal, row.id, started.reason);
    }
  }

  /** Who the finished review goes to: the one who has it, the rules in order, or the owner. */
  async function choose(
    principal: Principal,
    row: ReviewRow,
    rules: AssignmentRule[],
    values: CiFields & { contract_type: string },
  ): Promise<{ user: string } | { among: string[] }> {
    const { workspaceId } = principal;
    if (row.assignee_id && (await canTake(workspaceId, row.assignee_id, row))) {
      return { user: row.assignee_id };
    }
    for (const target of ciAssignmentOrder(rules, values)) {
      if ("user_id" in target) {
        if (await canTake(workspaceId, target.user_id, row)) return { user: target.user_id };
        continue;
      }
      const members = await asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ user_id: string }>(
          "select user_id from core.group_member where group_id = $1 order by user_id",
          [target.group_id],
        );
        return rows.map((m) => m.user_id);
      });
      const among: string[] = [];
      for (const id of members) if (await canTake(workspaceId, id, row)) among.push(id);
      if (among.length) return { among };
    }
    return { user: row.owner_id };
  }

  async function finish(principal: Principal, row: ReviewRow, review: Review) {
    const agent = await asApp(pool, principal, (db) => loadAgent(db, row.agent_id));
    if (!agent) return failReview(principal, row.id, "FORBIDDEN");
    const result = ciStatus(review, agent.thresholds as CiThresholds);
    const summary = ciSummary(review);
    const chosen = await choose(principal, row, agent.assignment, {
      ...row.fields,
      contract_type: agent.contract_type,
    });
    const assignee = await asApp(pool, principal, async (db) => {
      // Holding the row is what makes one worker, and only one, finish the review.
      const { rows: held } = await db.query<{ assignee_id: string | null }>(
        `select assignee_id from apps.ci_contract_review
          where id = $1 and status = 'running' and playbook_review_id = $2 for update`,
        [row.id, review.id],
      );
      if (!held[0]) return null;
      let user: string;
      // Someone given it by hand since the row was read keeps it.
      if (held[0].assignee_id && held[0].assignee_id !== row.assignee_id) {
        user = held[0].assignee_id;
      } else if ("user" in chosen) user = chosen.user;
      else {
        // The row lock on the agent hands concurrent reviews different turns.
        const { rows } = await db.query<{ turn: number }>(
          `update apps.ci_review_agent set round_robin_cursor = round_robin_cursor + 1
            where id = $1 returning round_robin_cursor - 1 turn`,
          [row.agent_id],
        );
        user = chosen.among[(rows[0]?.turn ?? 0) % chosen.among.length] ?? row.owner_id;
      }
      await db.query(
        `update apps.ci_contract_review
            set status = $2, result = $2, summary = $3, assignee_id = $4, reviewed_at = now(),
                updated_at = now()
          where id = $1`,
        [row.id, result, summary, user],
      );
      await audit(db, principal, "ci.review.finished", "ci_review", row.id, { result }, NO_CLIENT);
      await audit(
        db,
        principal,
        "ci.review.assigned",
        "ci_review",
        row.id,
        { assignee_id: user },
        NO_CLIENT,
      );
      return user;
    });
    if (assignee) await tell(principal, row, assignee, null);
  }

  /** Looks at a running review and records how it ended, if it has. */
  async function follow(principal: Principal, row: ReviewRow) {
    const review = row.playbook_review_id
      ? await reviews.get(principal, row.playbook_review_id)
      : null;
    if (!review) return failReview(principal, row.id, "ACCESS_LOST");
    if (review.status === "done") return finish(principal, row, review);
    if (review.status === "failed") return failReview(principal, row.id, "REVIEW_FAILED");
    if (review.status === "cancelled") return failReview(principal, row.id, "REVIEW_CANCELLED");
    if (Date.now() - (row.started_at?.getTime() ?? 0) > staleMs) {
      return failReview(principal, row.id, "TIMED_OUT");
    }
    return later(principal, row.id, pollSeconds);
  }

  async function step(claim: { id: string; workspace_id: string; owner_id: string }) {
    const principal: Principal = {
      sessionId: "ci-queue",
      userId: claim.owner_id,
      workspaceId: claim.workspace_id,
    };
    const row = await asApp(pool, principal, (db) => loadReview(db, claim.id));
    if (!row) {
      await asWorker(pool, (w) => w.query("select apps.fail_ci_review($1)", [claim.id]));
      return;
    }
    if (row.status === "queued") await begin(principal, row);
    else if (row.status === "running") await follow(principal, row);
  }

  async function tick(workspaceId?: string) {
    const seen: string[] = [];
    while (seen.length < (options.batch ?? 10)) {
      // One at a time, so a lease never runs out while its row waits behind others.
      const claim = await asWorker(
        pool,
        async (w) =>
          (
            await w.query<{ id: string; workspace_id: string; owner_id: string }>(
              "select id, workspace_id, owner_id from apps.claim_ci_review($1, $2, $3)",
              [leaseSeconds, workspaceId ?? null, seen],
            )
          ).rows[0],
      );
      if (!claim) return;
      seen.push(claim.id);
      try {
        await step(claim);
      } catch (err) {
        // Its lease runs out and it is tried again.
        log(`contract review ${claim.id} failed to advance: ${describeError(err)}`);
      }
    }
  }

  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  const scheduled = () => {
    running ??= tick()
      .catch((err) => log(`contract review queue failed: ${describeError(err)}`))
      .finally(() => {
        running = null;
      });
  };

  /**
   * The caller's own review, to act on: the agent's owner or whoever it is assigned to. The row
   * is locked first, so the answer still holds when the same transaction writes.
   */
  async function mine(db: Db, principal: Principal, id: string) {
    if (UUID.test(id)) {
      await db.query("select 1 from apps.ci_contract_review where id = $1 for update", [id]);
    }
    const row = (await loadReview(db, id)) ?? refuse("NOT_FOUND");
    if (row.owner_id !== principal.userId && row.assignee_id !== principal.userId) {
      refuse("FORBIDDEN");
    }
    return row;
  }

  return {
    async createAgent(principal, input, client) {
      return guarded(principal, async (db) => {
        if (!(await canBuild(db))) refuse("FORBIDDEN");
        await playbookState(db, input.playbook_id);
        const { rows } = await db.query<AgentRow>(
          `insert into apps.ci_review_agent (workspace_id, owner_id, name, contract_type,
             playbook_id, party, paper, assignment, thresholds)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${AGENT_COLUMNS}`,
          [
            principal.workspaceId,
            principal.userId,
            input.name,
            input.contract_type,
            input.playbook_id,
            input.party,
            input.paper,
            JSON.stringify(input.assignment),
            JSON.stringify(input.thresholds),
          ],
        );
        const agent = toAgent(rows[0] as AgentRow);
        await audit(
          db,
          principal,
          "ci.agent.created",
          "ci_agent",
          agent.id,
          { playbook_id: agent.playbook_id },
          client,
        );
        return agent;
      });
    },

    async listAgents(principal) {
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<AgentRow>(
          `select ${AGENT_COLUMNS} from apps.ci_review_agent order by created_at desc, id desc
            limit 200`,
        );
        return rows.map(toAgent);
      });
    },

    async getAgent(principal, id) {
      const row = await asApp(pool, principal, (db) => loadAgent(db, id));
      return row ? toAgent(row) : null;
    },

    async assigneeNames(principal, agent) {
      const targets = agent.assignment.flatMap((rule): { user_id?: string; group_id?: string }[] =>
        rule.kind === "field" ? rule.cases.map((c) => c.assignee) : [rule],
      );
      const users = targets.flatMap((t) => (t.user_id ? [t.user_id] : []));
      const groups = targets.flatMap((t) => (t.group_id ? [t.group_id] : []));
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ id: string; name: string }>(
          `select id, coalesce(nullif(name, ''), email) name from core."user" where id = any ($1)
           union all
           select id, name from core."group" where id = any ($2)`,
          [users, groups],
        );
        return Object.fromEntries(rows.map((r) => [r.id, r.name]));
      });
    },

    async dashboard(principal, since) {
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<Omit<CiDashboard, "as_of"> & { as_of: Date }>(
          `select count(*) filter (where r.reviewed_at > $1)::int since_last_visit,
                  count(*) filter (where r.status = any ($2))::int ready_to_review,
                  count(*) filter (where r.assignee_id = $3
                                     and r.status <> 'done')::int assigned_to_me,
                  now() as_of
             from apps.ci_contract_review r
             join content.document d on d.id = r.document_id`,
          [since ?? null, CiResult.options, principal.userId],
        );
        const row = rows[0] as Omit<CiDashboard, "as_of"> & { as_of: Date };
        return { ...row, as_of: row.as_of.toISOString() };
      });
    },

    async patchAgent(principal, id, patch, client) {
      return guarded(principal, async (db) => {
        const before = (await loadAgent(db, id)) ?? refuse("NOT_FOUND");
        if (!(await canBuild(db))) refuse("FORBIDDEN");
        const next = { ...before, ...patch };
        if (patch.playbook_id) {
          const state = await playbookState(db, patch.playbook_id);
          if (before.status === "live" && !state.published) refuse("NOT_PUBLISHED");
        }
        const { rows } = await db.query<AgentRow>(
          `update apps.ci_review_agent
              set name = $2, contract_type = $3, playbook_id = $4, party = $5, paper = $6,
                  assignment = $7, thresholds = $8, updated_at = now()
            where id = $1 returning ${AGENT_COLUMNS}`,
          [
            id,
            next.name,
            next.contract_type,
            next.playbook_id,
            next.party,
            next.paper,
            JSON.stringify(next.assignment),
            JSON.stringify(next.thresholds),
          ],
        );
        await audit(
          db,
          principal,
          "ci.agent.updated",
          "ci_agent",
          id,
          { fields: Object.keys(patch) },
          client,
        );
        return toAgent(rows[0] as AgentRow);
      });
    },

    async setAgentStatus(principal, id, status, client) {
      return guarded(principal, async (db) => {
        const agent = (await loadAgent(db, id)) ?? refuse("NOT_FOUND");
        if (!(await canBuild(db))) refuse("FORBIDDEN");
        if (status === "live" && !(await playbookState(db, agent.playbook_id)).published) {
          refuse("NOT_PUBLISHED");
        }
        const { rows } = await db.query<AgentRow>(
          `update apps.ci_review_agent set status = $2, updated_at = now()
            where id = $1 returning ${AGENT_COLUMNS}`,
          [id, status],
        );
        const action = status === "live" ? "ci.agent.activated" : "ci.agent.deactivated";
        await audit(db, principal, action, "ci_agent", id, {}, client);
        return toAgent(rows[0] as AgentRow);
      });
    },

    async createReview(principal, input, charge, client) {
      return guarded(principal, async (db) => {
        // Only the owner can see the agent, so a review never runs on someone else's behalf.
        const agent = (await loadAgent(db, input.agent_id)) ?? refuse("NOT_FOUND");
        if (!(await canBuild(db))) refuse("FORBIDDEN");
        if (agent.status !== "live") refuse("AGENT_NOT_LIVE");
        const meta = (await versionMeta(db, input.document_version_id)) ?? refuse("NOT_FOUND");
        const state = await playbookState(db, agent.playbook_id);
        if (!state.published) refuse("NOT_PUBLISHED");
        if (charge(asksFor(state.rules)) > 0) refuse("TOO_MANY_REQUESTS");
        const { rows } = await db.query<{ id: string }>(
          `insert into apps.ci_contract_review (workspace_id, ci_agent_id, agent_name, owner_id,
             playbook_id, document_id, document_version_id, counterparty, fields)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [
            principal.workspaceId,
            agent.id,
            agent.name,
            principal.userId,
            agent.playbook_id,
            meta.documentId,
            meta.versionId,
            input.counterparty ?? null,
            JSON.stringify(input.fields ?? {}),
          ],
        );
        const id = rows[0]?.id ?? "";
        await audit(
          db,
          principal,
          "ci.review.queued",
          "ci_review",
          id,
          { ci_agent_id: agent.id, document_version_id: meta.versionId },
          client,
        );
        await trackUsage(db, {
          surface: "apps",
          action: "ci_review",
          actionClass: "other",
          objectType: "ci_review",
          objectId: id,
          sourceKinds: ["file"],
          documentCount: 1,
        });
        return { review_id: id };
      });
    },

    async list(principal, filter) {
      let after: RegExpExecArray | null = null;
      if (filter.cursor) {
        after = CURSOR.exec(Buffer.from(filter.cursor, "base64url").toString());
        if (!after) return { ok: false, reason: "BAD_CURSOR" };
      }
      return guarded(principal, async (db) => {
        const { rows } = await db.query<ReviewRow>(
          `select ${REVIEW_COLUMNS} from ${REVIEW_FROM}
            where ($1::text is null or r.status = $1)
              and ($2::uuid is null or r.assignee_id = $2)
              and ($3::uuid is null or r.ci_agent_id = $3)
              and ($4::timestamptz is null or (r.updated_at, r.id) < ($4, $5::uuid))
              and ($6::text is null or strpos(lower(r.counterparty), lower($6)) > 0)
              and ($7::timestamptz is null or r.updated_at >= $7)
              and ($8::timestamptz is null or r.updated_at < $8)
            order by r.updated_at desc, r.id desc limit $9`,
          [
            filter.status ?? null,
            filter.assigneeId ?? null,
            filter.agentId ?? null,
            after?.[1] ?? null,
            after?.[2] ?? null,
            filter.counterparty?.replaceAll("\0", "") ?? null,
            filter.from ?? null,
            filter.to ?? null,
            pageSize + 1,
          ],
        );
        const page = rows.slice(0, pageSize);
        const last = rows.length > pageSize ? page.at(-1) : undefined;
        return {
          reviews: page.map(toReview),
          next_cursor: last
            ? Buffer.from(`${last.sort_key}|${last.id}`).toString("base64url")
            : null,
        };
      });
    },

    async get(principal, id) {
      const row = await asApp(pool, principal, (db) => loadReview(db, id));
      return row ? toReview(row) : null;
    },

    async assign(principal, id, assigneeId, client) {
      const found = await guarded(principal, (db) => mine(db, principal, id));
      if (!found.ok) return found;
      const row = found.value;
      if (row.status === "done") return { ok: false, reason: "WRONG_STATE" };
      if (!(await canTake(principal.workspaceId, assigneeId, row))) {
        return { ok: false, reason: "ASSIGNEE_NOT_ALLOWED" };
      }
      const saved = await guarded(principal, async (db) => {
        const now = await mine(db, principal, id);
        // Eligibility was judged against this playbook.
        if (now.playbook_id !== row.playbook_id) refuse("WRONG_STATE");
        const { rowCount } = await db.query(
          `update apps.ci_contract_review
              set assignee_id = $2, assigned_by = $3, updated_at = now()
            where id = $1 and status <> 'done'`,
          [id, assigneeId, principal.userId],
        );
        if (!rowCount) refuse("WRONG_STATE");
        await audit(
          db,
          principal,
          "ci.review.assigned",
          "ci_review",
          id,
          { assignee_id: assigneeId },
          client,
        );
        return toReview((await loadReview(db, id)) ?? refuse("NOT_FOUND"));
      });
      if (saved.ok) {
        await tell(principal, row, assigneeId, principal.userId);
      }
      return saved;
    },

    async markDone(principal, id, client) {
      return guarded(principal, async (db) => {
        const row = await mine(db, principal, id);
        const { rowCount } = await db.query(
          `update apps.ci_contract_review
              set status = 'done', done_at = now(), updated_at = now()
            where id = $1 and status = any ($2)`,
          [id, CiResult.options],
        );
        if (!rowCount) refuse("WRONG_STATE");
        await audit(
          db,
          principal,
          "ci.review.status_changed",
          "ci_review",
          id,
          { from: row.status, to: "done" },
          client,
        );
        await trackOutcome(db, {
          workflowType: "contract_reviewed",
          since: row.created_at,
          once: `ci_review:${id}`,
        });
        return toReview((await loadReview(db, id)) ?? refuse("NOT_FOUND"));
      });
    },

    async rerun(principal, id, charge, client) {
      return guarded(principal, async (db) => {
        const row = (await loadReview(db, id)) ?? refuse("NOT_FOUND");
        // It runs as the owner and spends the owner's budget, so only they ask for it.
        if (row.owner_id !== principal.userId || !(await canBuild(db))) refuse("FORBIDDEN");
        if (row.status === "queued" || row.status === "running") refuse("WRONG_STATE");
        const agent = (await loadAgent(db, row.agent_id)) ?? refuse("NOT_FOUND");
        if (agent.status !== "live") refuse("AGENT_NOT_LIVE");
        const state = await playbookState(db, agent.playbook_id);
        if (!state.published) refuse("NOT_PUBLISHED");
        if (charge(asksFor(state.rules)) > 0) refuse("TOO_MANY_REQUESTS");
        const { rowCount } = await db.query(
          `update apps.ci_contract_review
              set status = 'queued', result = null, summary = null, failure = null,
                  playbook_review_id = null, run_id = null, started_at = null, done_at = null,
                  reviewed_at = null, assigned_by = null,
                  next_attempt_at = now(), updated_at = now()
            where id = $1 and status not in ('queued', 'running')`,
          [id],
        );
        if (!rowCount) refuse("WRONG_STATE");
        await audit(
          db,
          principal,
          "ci.review.status_changed",
          "ci_review",
          id,
          { from: row.status, to: "queued" },
          client,
        );
        return { review_id: id };
      });
    },

    tick,
    start() {
      timer ??= setInterval(scheduled, options.intervalMs ?? 5_000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
