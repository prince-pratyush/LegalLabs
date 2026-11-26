import { contentKey, type ObjectStore } from "@legallabs/storage";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp } from "../db.js";
import type { Notifier } from "../notifications/notify.js";

export type Scope = "workspace" | "vault" | "matter";
export type HoldType = "thread" | "document" | "vault" | "review_table" | "matter";

/** Kept whatever the policy says; shown on the retention page. */
export const EXEMPT_TYPES = [
  { type: "library_item", label: "Library prompts and templates" },
  { type: "template_file", label: "Template files" },
  { type: "export_file", label: "Export files, for 7 days after creation" },
  { type: "audit_event", label: "The audit log" },
  { type: "usage_event", label: "Usage events" },
  { type: "analytics_daily", label: "Analytics" },
  { type: "matter", label: "Matter records" },
  { type: "hold", label: "Anything under a legal hold" },
] as const;

export interface Estimate {
  threads: number;
  documents: number;
  reviewTables: number;
  total: number;
  held: number;
  firstDeletionAt: string | null;
}

export interface PolicyRow {
  policyId: string | null;
  scope: Scope;
  scopeId: string;
  name: string | null;
  /** Null is kept for ever. */
  hours: number | null;
  basis: "upload" | "access";
  /** `legacy` is a vault's older retention setting, treated as its vault policy. */
  source: "policy" | "legacy";
  updatedAt: string;
  updatedBy: string | null;
}

export interface Policies {
  workspace: PolicyRow | null;
  /** `effectiveHours` is what applies: never longer than the workspace's (SEC-029). */
  vaults: (PolicyRow & { effectiveHours: number | null })[];
  matters: (PolicyRow & { effectiveHours: number | null })[];
}

export interface BinItem {
  id: string;
  objectType: "thread" | "document" | "review_table";
  objectId: string;
  label: string;
  deletedAt: string;
  restorableUntil: string;
  restoredAt: string | null;
  purgedAt: string | null;
}

export interface Hold {
  id: string;
  objectType: HoldType;
  objectId: string;
  reason: string;
  setBy: string;
  setAt: string;
}

export interface DeletionJob {
  id: string;
  kind: "policy_change" | "sweep" | "purge";
  status: "queued" | "running" | "done" | "failed";
  estimate: unknown;
  report: unknown;
  scheduledFor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  requestedBy: string | null;
  createdAt: string;
}

export type Reason =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RETENTION_MIN"
  | "CONFIRM_REQUIRED"
  | "NOT_RESTORABLE"
  | "HELD"
  | "VAULT_DELETED"
  | "INVALID";
export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: Reason; estimate?: Estimate };

export interface SetPolicyInput {
  scope: Scope;
  scopeId: string;
  hours: number | null;
  confirmSlug?: string | undefined;
  basis?: "upload" | "access" | undefined;
}

export interface Retention {
  policies(p: Principal): Promise<Outcome<Policies>>;
  estimate(
    p: Principal,
    scope: Scope,
    scopeId: string,
    hours: number | null,
  ): Promise<Outcome<Estimate>>;
  setPolicy(
    p: Principal,
    client: Client,
    input: SetPolicyInput,
  ): Promise<Outcome<{ policyId: string; jobId: string; estimate: Estimate }>>;
  clearPolicy(
    p: Principal,
    client: Client,
    scope: Scope,
    scopeId: string,
  ): Promise<Outcome<boolean>>;
  holds(p: Principal): Promise<Outcome<Hold[]>>;
  setHold(
    p: Principal,
    client: Client,
    input: { objectType: HoldType; objectId: string; held: boolean; reason?: string },
  ): Promise<Outcome<boolean>>;
  bin(p: Principal, options?: { includeClosed?: boolean }): Promise<Outcome<BinItem[]>>;
  restore(
    p: Principal,
    client: Client,
    binId: string,
  ): Promise<Outcome<{ objectType: string; objectId: string }>>;
  purgeNow(p: Principal, client: Client, binId: string): Promise<Outcome<{ files: number }>>;
  jobs(p: Principal): Promise<Outcome<DeletionJob[]>>;
  exemptions(): readonly { type: string; label: string }[];
}

const KNOWN = new Set<Reason>([
  "NOT_FOUND",
  "RETENTION_MIN",
  "CONFIRM_REQUIRED",
  "NOT_RESTORABLE",
  "HELD",
  "VAULT_DELETED",
]);
const INVALID = new Set(["INVALID_SCOPE", "INVALID_BASIS", "INVALID_REASON"]);

function reasonOf(err: unknown): Reason | null {
  if (typeof err !== "object" || err === null) return null;
  const { code, message } = err as { code?: string; message?: string };
  if (code === "42501" || message === "FORBIDDEN") return "FORBIDDEN";
  if (message && KNOWN.has(message as Reason)) return message as Reason;
  if (message && INVALID.has(message)) return "INVALID";
  // A malformed id reaches the database as text.
  if (code === "22P02") return "INVALID";
  return null;
}

async function attempt<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (err) {
    const reason = reasonOf(err);
    if (!reason) throw err;
    return { ok: false, reason };
  }
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toEstimate(raw: Record<string, unknown>): Estimate {
  return {
    threads: Number(raw.threads ?? 0),
    documents: Number(raw.documents ?? 0),
    reviewTables: Number(raw.review_tables ?? 0),
    total: Number(raw.total ?? 0),
    held: Number(raw.held ?? 0),
    firstDeletionAt: (raw.first_deletion_at as string | null) ?? null,
  };
}

/** Tells the function who is asking, so the audit trail carries the address and browser. */
async function withClient(db: pg.PoolClient, client: Client) {
  await db.query(
    "select set_config('app.client_ip', $1, true), set_config('app.ua_hash', $2, true)",
    [client.ip ?? "", uaHash(client) ?? ""],
  );
}

async function requireAdmin(db: pg.PoolClient): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    "select core.has_permission('admin.retention') ok",
  );
  return rows[0]?.ok === true;
}

export function createRetention(
  pool: pg.Pool,
  options: { store: ObjectStore; notifications?: Notifier },
): Retention {
  const guarded = <T>(p: Principal, read: (db: pg.PoolClient) => Promise<T>): Promise<Outcome<T>> =>
    asApp(pool, p, async (db) =>
      (await requireAdmin(db))
        ? ({ ok: true, value: await read(db) } as Outcome<T>)
        : ({ ok: false, reason: "FORBIDDEN" } as Outcome<T>),
    );

  async function deleteFiles(workspaceId: string, hashes: string[]) {
    for (const hash of hashes) await options.store.delete(contentKey(workspaceId, hash));
  }

  return {
    exemptions: () => EXEMPT_TYPES,

    policies: (p) =>
      guarded(p, async (db) => {
        const { rows } = await db.query<{
          policy_id: string | null;
          scope: Scope;
          scope_id: string;
          name: string | null;
          hours: number | null;
          basis: "upload" | "access";
          source: "policy" | "legacy";
          updated_at: Date;
          updated_by: string | null;
          effective_hours: number | null;
        }>("select * from retention.list_policies()");
        const all = rows.map((r) => ({
          policyId: r.policy_id,
          scope: r.scope,
          scopeId: r.scope_id,
          name: r.name,
          hours: r.hours,
          basis: r.basis,
          source: r.source,
          updatedAt: r.updated_at.toISOString(),
          updatedBy: r.updated_by,
          effectiveHours: r.effective_hours,
        }));
        const at = (scope: Scope) => all.filter((r) => r.scope === scope);
        return {
          workspace: at("workspace")[0] ?? null,
          vaults: at("vault"),
          matters: at("matter"),
        };
      }),

    estimate: (p, scope, scopeId, hours) =>
      attempt(() =>
        asApp(pool, p, async (db) => {
          const { rows } = await db.query<{ e: Record<string, unknown> }>(
            "select retention.estimate($1, $2, $3) e",
            [scope, scopeId, hours],
          );
          return toEstimate(rows[0]?.e ?? {});
        }),
      ),

    async setPolicy(p, client, input) {
      let result:
        | {
            policy_id: string;
            job_id: string;
            estimate: Record<string, unknown>;
            warn_vaults: {
              vault_id: string;
              name: string;
              owner_id: string;
              matter_id: string | null;
            }[];
            admin_ids: string[];
          }
        | undefined;
      const outcome = await attempt(() =>
        asApp(pool, p, async (db) => {
          await withClient(db, client);
          const { rows } = await db.query<{ r: NonNullable<typeof result> }>(
            "select retention.set_policy($1, $2, $3, $4, $5) r",
            [
              input.scope,
              input.scopeId,
              input.hours,
              input.confirmSlug ?? null,
              input.basis ?? "upload",
            ],
          );
          result = rows[0]?.r;
        }),
      );
      if (!outcome.ok) {
        if (outcome.reason !== "CONFIRM_REQUIRED") return outcome;
        const again = await this.estimate(p, input.scope, input.scopeId, input.hours);
        return again.ok ? { ...outcome, estimate: again.value } : outcome;
      }
      if (!result) return { ok: false, reason: "INVALID" };
      const estimate = toEstimate(result.estimate);
      // After commit, and never fatal: telling people is not part of saving the policy.
      const notifier = options.notifications;
      if (notifier) {
        if (estimate.total > 0) {
          await notifier.notify(p, {
            kind: "admin.retention_deletion_scheduled",
            actorId: p.userId,
            objectType: "admin",
            objectId: result.job_id,
            objectTitle: `${estimate.total} items under a new retention policy`,
            people: { admins: result.admin_ids },
          });
        }
        for (const vault of result.warn_vaults) {
          await notifier.notify(p, {
            kind: "vault.retention_warning",
            actorId: null,
            objectType: "vault",
            objectId: vault.vault_id,
            objectTitle: vault.name,
            matterId: vault.matter_id,
            people: { owner: vault.owner_id, recipients: result.admin_ids },
          });
        }
      }
      return { ok: true, value: { policyId: result.policy_id, jobId: result.job_id, estimate } };
    },

    clearPolicy: (p, client, scope, scopeId) =>
      attempt(() =>
        asApp(pool, p, async (db) => {
          await withClient(db, client);
          const { rows } = await db.query<{ ok: boolean }>(
            "select retention.clear_policy($1, $2) ok",
            [scope, scopeId],
          );
          return rows[0]?.ok === true;
        }),
      ),

    holds: (p) =>
      guarded(p, async (db) => {
        const { rows } = await db.query<{
          id: string;
          object_type: HoldType;
          object_id: string;
          reason: string;
          set_by: string;
          set_at: Date;
        }>(
          "select id, object_type, object_id, reason, set_by, set_at from retention.hold order by set_at desc",
        );
        return rows.map((r) => ({
          id: r.id,
          objectType: r.object_type,
          objectId: r.object_id,
          reason: r.reason,
          setBy: r.set_by,
          setAt: r.set_at.toISOString(),
        }));
      }),

    setHold: (p, client, input) =>
      attempt(() =>
        asApp(pool, p, async (db) => {
          await withClient(db, client);
          const { rows } = await db.query<{ ok: boolean }>(
            "select retention.set_hold($1, $2, $3, $4) ok",
            [input.objectType, input.objectId, input.held, input.reason ?? null],
          );
          return rows[0]?.ok === true;
        }),
      ),

    bin: (p, opts = {}) =>
      guarded(p, async (db) => {
        const { rows } = await db.query<{
          id: string;
          object_type: BinItem["objectType"];
          object_id: string;
          label: string;
          deleted_at: Date;
          restorable_until: Date;
          restored_at: Date | null;
          purged_at: Date | null;
        }>(
          `select id, object_type, object_id, label, deleted_at, restorable_until, restored_at, purged_at
             from retention.recycle_bin
            where $1 or (restored_at is null and purged_at is null)
            order by deleted_at desc, id limit 500`,
          [opts.includeClosed === true],
        );
        return rows.map((r) => ({
          id: r.id,
          objectType: r.object_type,
          objectId: r.object_id,
          label: r.label,
          deletedAt: r.deleted_at.toISOString(),
          restorableUntil: r.restorable_until.toISOString(),
          restoredAt: iso(r.restored_at),
          purgedAt: iso(r.purged_at),
        }));
      }),

    restore: (p, client, binId) =>
      attempt(() =>
        asApp(pool, p, async (db) => {
          await withClient(db, client);
          const { rows } = await db.query<{ r: { object_type: string; object_id: string } }>(
            "select retention.restore($1) r",
            [binId],
          );
          const r = rows[0]?.r;
          return { objectType: r?.object_type ?? "", objectId: r?.object_id ?? "" };
        }),
      ),

    async purgeNow(p, client, binId) {
      const outcome = await attempt(() =>
        asApp(pool, p, async (db) => {
          await withClient(db, client);
          const { rows } = await db.query<{ r: { blobs: string[]; workspace_id: string } }>(
            "select retention.purge_now($1) r",
            [binId],
          );
          return rows[0]?.r ?? { blobs: [], workspace_id: p.workspaceId };
        }),
      );
      if (!outcome.ok) return outcome;
      // After commit, so a crash leaves an unreachable file, never a row without its file.
      await deleteFiles(outcome.value.workspace_id, outcome.value.blobs);
      return { ok: true, value: { files: outcome.value.blobs.length } };
    },

    jobs: (p) =>
      guarded(p, async (db) => {
        const { rows } = await db.query<{
          id: string;
          kind: DeletionJob["kind"];
          status: DeletionJob["status"];
          estimate: unknown;
          report: unknown;
          scheduled_for: Date | null;
          started_at: Date | null;
          finished_at: Date | null;
          requested_by: string | null;
          created_at: Date;
        }>("select * from retention.deletion_job order by created_at desc, id limit 200");
        return rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          estimate: r.estimate,
          report: r.report,
          scheduledFor: iso(r.scheduled_for),
          startedAt: iso(r.started_at),
          finishedAt: iso(r.finished_at),
          requestedBy: r.requested_by,
          createdAt: r.created_at.toISOString(),
        }));
      }),
  };
}
