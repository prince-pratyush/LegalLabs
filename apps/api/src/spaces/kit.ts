import type { SpaceResourceType, SpaceRole } from "@legallabs/contracts";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp } from "../db.js";

export type Db = pg.PoolClient;

export type Failure =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID"
  | "MATTER_NOT_FOUND"
  | "MATTER_HAS_SPACE"
  | "NAME_TAKEN"
  | "EXTERNAL_NOT_ENABLED"
  | "MAIL_UNAVAILABLE"
  | "ALREADY_MEMBER"
  | "NOT_MEMBER"
  | "LAST_ADMIN"
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_UNSUPPORTED"
  | "MATTER_MISMATCH"
  | "PHASE_LOCKED"
  | "GATE_NEEDS_APPROVAL"
  | "NOT_AWAITING_APPROVAL"
  | "NOT_A_GATE"
  | "AGENT_NOT_SHARED"
  | "INVALID_ASSIGNEE"
  | "MENTION_NOT_VISIBLE"
  | "COMMENT_REQUIRED"
  | "EDIT_WINDOW_CLOSED"
  | "TOO_MANY"
  | "RUN_START_FAILED"
  | "RUN_UNAVAILABLE"
  | "NO_RUN"
  | "ALREADY_REQUESTED"
  | "ALREADY_DECIDED"
  | "GUEST_DOMAIN_MISMATCH"
  | "PARTY_LIMIT"
  | "EMAIL_IS_MEMBER"
  | "CONNECTION_NOT_APPROVED"
  | "CONNECTION_NOT_PENDING"
  | "ALREADY_APPROVED"
  | "INVITE_INVALID"
  | "NO_PARTY"
  | "SPACE_NOT_EXTERNAL"
  | "INVALID_PARTY_LEVEL"
  | "UNKNOWN_PARTY"
  | "WALL_SHARE_BLOCKED"
  | "SHARE_REQUEST_COOLDOWN"
  | "SHARE_REQUEST_STALE";

export type Result<T> = { ok: true; value: T } | { ok: false; reason: Failure };

export class Refused extends Error {
  constructor(readonly reason: Failure) {
    super(reason);
  }
}

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = (reason: Failure): Result<never> => ({ ok: false, reason });

// Raised by the triggers in the work schema.
const SQL_REFUSALS: Record<string, Failure> = {
  PHASE_LOCKED: "PHASE_LOCKED",
  GATE_NEEDS_APPROVAL: "GATE_NEEDS_APPROVAL",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  // Guests and external Spaces (0161).
  GUEST_DOMAIN_MISMATCH: "GUEST_DOMAIN_MISMATCH",
  PARTY_LIMIT: "PARTY_LIMIT",
  EMAIL_IS_MEMBER: "EMAIL_IS_MEMBER",
  CONNECTION_NOT_APPROVED: "CONNECTION_NOT_APPROVED",
  CONNECTION_NOT_PENDING: "CONNECTION_NOT_PENDING",
  ALREADY_APPROVED: "ALREADY_APPROVED",
  INVITE_INVALID: "INVITE_INVALID",
  NO_PARTY: "NO_PARTY",
  SPACE_NOT_EXTERNAL: "SPACE_NOT_EXTERNAL",
  INVALID_PARTY_LEVEL: "INVALID_PARTY_LEVEL",
  UNKNOWN_PARTY: "UNKNOWN_PARTY",
  PER_PARTY_NEEDS_EXTERNAL_SPACE: "SPACE_NOT_EXTERNAL",
  GUEST_MEMBERSHIP_INVALID: "INVALID",
  // Agent grants (0200).
  AGENT_LEVEL_INVALID: "INVALID",
};

// Unique indexes that mean something to the caller.
const UNIQUE: Record<string, Failure> = {
  space_matter_idx: "MATTER_HAS_SPACE",
  space_name_idx: "NAME_TAKEN",
  space_member_space_id_principal_type_principal_id_key: "ALREADY_MEMBER",
  space_access_pending_idx: "ALREADY_REQUESTED",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (value: string) => UUID.test(value);

export function failureOf(err: unknown): Failure | null {
  if (err instanceof Refused) return err.reason;
  const e = err as { message?: string; code?: string; constraint?: string };
  const message = e.message ?? "";
  const named = SQL_REFUSALS[message];
  if (named) return named;
  // A policy refusing a row: the caller may not do this here.
  if (e.code === "42501") return "FORBIDDEN";
  if (e.code === "23505" && e.constraint && UNIQUE[e.constraint])
    return UNIQUE[e.constraint] ?? null;
  // A principal outside the workspace.
  if (e.code === "23503" && /not in this workspace/.test(message)) return "NOT_MEMBER";
  return null;
}

export interface NotifyEvent {
  kind:
    | "mention"
    | "task.returned"
    | "task.assigned"
    | "space.access_requested"
    | "space.access_decided";
  userIds: string[];
  spaceId: string;
  taskId?: string;
  /** What the notification calls the object: a Space's or a task's name, never a comment's text. */
  title: string;
  /** For `space.access_decided`: whether the request was accepted. */
  accepted?: boolean;
}

/** Who to tell. The notifications hub supplies the real one; the default tells no one. */
export interface SpaceNotifier {
  notify(p: { workspaceId: string; actorId: string }, event: NotifyEvent): Promise<void>;
}
export const noNotifications: SpaceNotifier = { notify: async () => {} };

export interface Kit {
  /** Runs `work` in one transaction as the caller; refusals become a Result. */
  attempt<T>(
    p: Principal,
    work: (db: Db, notify: (event: NotifyEvent) => void) => Promise<T>,
  ): Promise<Result<T>>;
  audit(
    db: Db,
    p: Principal,
    client: Client,
    action: string,
    objectType: string,
    objectId: string,
    details?: object,
  ): Promise<void>;
  activity(
    db: Db,
    p: Principal,
    spaceId: string,
    type: string,
    object?: { type: string; id: string } | null,
    details?: object,
    actor?: "user" | "assistant" | "agent" | "system",
  ): Promise<void>;
}

export function createKit(pool: pg.Pool, notifier: SpaceNotifier): Kit {
  return {
    async attempt(p, work) {
      const events: NotifyEvent[] = [];
      try {
        const value = await asApp(pool, p, (db) => work(db, (event) => events.push(event)));
        // After the commit, so nobody is told about something that then rolled back.
        for (const event of events) {
          await notifier
            .notify({ workspaceId: p.workspaceId, actorId: p.userId }, event)
            .catch(() => {});
        }
        return ok(value);
      } catch (err) {
        const reason = failureOf(err);
        if (reason) return refuse(reason);
        throw err;
      }
    },
    async audit(db, p, client, action, objectType, objectId, details = {}) {
      await db.query("select admin.append_audit_event($1, 'user', $2, $3, $4, $5, $6, $7)", [
        action,
        p.userId,
        objectType,
        objectId,
        JSON.stringify(details),
        client.ip,
        uaHash(client),
      ]);
    },
    async activity(db, p, spaceId, type, object = null, details = {}, actor = "user") {
      await db.query(
        `insert into work.space_activity
           (workspace_id, space_id, actor_id, actor_type, type, object_type, object_id, details)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          p.workspaceId,
          spaceId,
          actor === "user" ? p.userId : null,
          actor,
          type,
          object?.type ?? null,
          object?.id ?? null,
          JSON.stringify(details),
        ],
      );
    },
  };
}

/** The matter as every list shows it; the matters epic's display format replaces this. */
export const matterDisplay = (
  m: { client_id: string; client_name: string; matter_number: string } | null,
) => (m ? `${m.client_id}-${m.matter_number} ${m.client_name}` : null);

export interface ResourceInfo {
  name: string;
  ownerId: string | null;
  matterId: string | null;
  /** Whether the caller may share it onward: its owner, or Full. */
  full: boolean;
}

/** How Spaces finds a resource to share. A type with no entry cannot be shared yet. */
export type ResourceCatalog = Partial<
  Record<SpaceResourceType, (db: Db, id: string) => Promise<ResourceInfo | null>>
>;

export const one = async <T extends pg.QueryResultRow>(db: Db, sql: string, params: unknown[]) =>
  (await db.query<T>(sql, params)).rows[0] ?? null;

export const refusal = (reason: Failure) => new Refused(reason);

/** The caller's role in a Space, or null when it is absent to them. */
export async function roleOf(db: Db, id: string): Promise<SpaceRole | null> {
  if (!isId(id)) return null;
  const row = await one<{ role: SpaceRole | null }>(db, "select work.space_role($1) as role", [id]);
  return row?.role ?? null;
}

/** Any role in the Space, or a refusal that looks like absence. */
export async function needMember(db: Db, id: string): Promise<SpaceRole> {
  const role = await roleOf(db, id);
  if (!role) throw refusal("NOT_FOUND");
  return role;
}

export async function needAdmin(db: Db, id: string): Promise<void> {
  if ((await needMember(db, id)) !== "admin") throw refusal("FORBIDDEN");
}
