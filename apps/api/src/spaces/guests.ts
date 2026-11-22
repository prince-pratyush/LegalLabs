import { createHash, randomBytes, randomInt } from "node:crypto";
import type { GuestInviteInput, PartyInput } from "@legallabs/contracts";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp, type Identity } from "../db.js";
import {
  type Db,
  failureOf,
  isId,
  type Kit,
  needAdmin,
  ok,
  one,
  type ResourceCatalog,
  type Result,
  refusal,
  refuse,
} from "./kit.js";

/** A guest's session ends 24 hours after sign-in, whatever they do: no renewal. */
export const GUEST_SESSION_SECONDS = 24 * 60 * 60;

/**
 * Sends a sign-in code to a guest. The default sends nothing: no mail provider is wired yet, and
 * a deployment that has one supplies it. The code is never stored or logged in the clear.
 */
export interface GuestMailer {
  sendCode(to: { workspace: string; email: string }, code: string): Promise<void>;
}
export const noGuestMail: GuestMailer = { sendCode: async () => {} };

/** A mailer that remembers what it was asked to send, for tests and demos. */
export function recordingGuestMailer(): GuestMailer & {
  readonly sent: { workspace: string; email: string; code: string }[];
} {
  const sent: { workspace: string; email: string; code: string }[] = [];
  return {
    sent,
    async sendCode(to, code) {
      sent.push({ workspace: to.workspace, email: to.email, code });
    },
  };
}

export interface PartyView {
  id: string;
  name: string;
  domain: string;
  connectionAdminEmails: string[];
  connection: {
    status: "action_required" | "in_progress" | "resolved" | "rejected";
    approvals: { side: "internal" | "external"; at: string }[];
    rejectedReason: string | null;
  };
  createdAt: string;
}

export interface GuestView {
  userId: string;
  email: string;
  name: string;
  partyId: string | null;
  expiresAt: string;
  status: "active" | "expired" | "deactivated";
}

export interface InviteView {
  id: string;
  email: string;
  accessDays: number;
  /** The one time the token is shown: only its hash is kept. */
  token: string;
  acceptUrl: string;
}

export interface InvitePreview {
  email: string;
  spaceName: string;
  workspaceName: string;
  partyName: string;
  expiresAt: string;
}

export interface GuestSpaceSummary {
  spaceId: string;
  spaceName: string;
  partyId: string;
  partyName: string;
  connectionStatus: string;
  canApprove: boolean;
  expiresAt: string;
}

export interface GuestSpaceView {
  space: { id: string; name: string; kind: "external"; workspaceName: string | null };
  party: { id: string; name: string };
  resources: {
    id: string;
    resourceType: string;
    resourceId: string;
    name: string | null;
    access: string;
  }[];
}

export interface Accepted {
  userId: string;
  workspaceId: string;
  workspaceSlug: string;
  spaceId: string;
}

export interface Guests {
  addParty(
    p: Principal,
    spaceId: string,
    input: PartyInput,
    client: Client,
  ): Promise<Result<PartyView>>;
  parties(p: Principal, spaceId: string): Promise<PartyView[] | null>;
  removeParty(
    p: Principal,
    spaceId: string,
    partyId: string,
    client: Client,
  ): Promise<Result<null>>;
  /** Either side approves: a Connection Admin of the workspace, or the party's own. */
  approve(
    p: Principal,
    spaceId: string,
    partyId: string,
    client: Client,
  ): Promise<Result<{ status: string }>>;
  reject(
    p: Principal,
    spaceId: string,
    partyId: string,
    reason: string | undefined,
    client: Client,
  ): Promise<Result<null>>;
  invite(
    p: Principal,
    spaceId: string,
    input: GuestInviteInput,
    client: Client,
  ): Promise<Result<InviteView>>;
  guests(p: Principal, spaceId: string): Promise<Result<GuestView[]>>;
  removeGuest(p: Principal, spaceId: string, userId: string, client: Client): Promise<Result<null>>;

  // Before anyone is signed in.
  preview(token: string): Promise<InvitePreview | null>;
  accept(token: string, name: string, client: Client): Promise<Result<Accepted>>;
  /** Always quiet about whether the address is a guest: the caller answers the same either way. */
  requestCode(workspace: string, email: string, client: Client): Promise<void>;
  /** A session that ends in 24 hours, or null: wrong, expired, spent or locked all look alike. */
  verifyCode(
    workspace: string,
    email: string,
    code: string,
    client: Client,
  ): Promise<{ token: string; principal: Principal } | null>;

  // As a signed-in guest.
  mySpaces(p: Principal): Promise<GuestSpaceSummary[]>;
  space(p: Principal, spaceId: string, client: Client): Promise<Result<GuestSpaceView>>;
}

export interface GuestsOptions {
  mailer?: GuestMailer;
  /** Where the invite link points; the token follows in the fragment, so no server log holds it. */
  acceptUrl?: string;
  now?: () => number;
}

const NOBODY: Identity = { userId: null, workspaceId: null };
const sha256 = (text: string) => createHash("sha256").update(text).digest();

/** The code is bound to the workspace and address, so a code for one is useless for another. */
const codeHash = (workspace: string, email: string, code: string) =>
  sha256(`${workspace}\n${email}\n${code}`);

interface PartyRow {
  id: string;
  name: string;
  domain: string;
  connection_admin_emails: string[];
  created_at: Date;
  status: PartyView["connection"]["status"];
  approvals: { side: "internal" | "external"; at: string }[];
  rejected_reason: string | null;
}

const PARTY_SQL = `
  select p.id, p.name, p.domain, p.connection_admin_emails, p.created_at,
         c.status, c.approvals, c.rejected_reason
    from work.space_party p join work.space_connection c on c.party_id = p.id`;

const partyView = (r: PartyRow): PartyView => ({
  id: r.id,
  name: r.name,
  domain: r.domain,
  connectionAdminEmails: r.connection_admin_emails,
  connection: {
    status: r.status,
    approvals: r.approvals.map((a) => ({ side: a.side, at: a.at })),
    rejectedReason: r.rejected_reason,
  },
  createdAt: r.created_at.toISOString(),
});

/** Acts as a person, or as no one inside one workspace (what a guest's own audit events use). */
const actAs = (db: Db, identity: Identity) =>
  db.query("select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)", [
    identity.userId ?? "",
    identity.workspaceId ?? "",
  ]);

/**
 * The audit chain refuses a user who is not an active member as an actor, and a guest never is, so
 * a guest's events are written as system events in their workspace with the guest named in the
 * details. Always the last thing a transaction does: it leaves the identity set to no one.
 */
async function auditAsSystem(
  db: Db,
  workspaceId: string,
  client: Client,
  action: string,
  objectType: string,
  objectId: string | null,
  details: object,
) {
  await actAs(db, { userId: null, workspaceId });
  await db.query("select admin.append_audit_event($1, 'system', null, $2, $3, $4, $5, $6)", [
    action,
    objectType,
    objectId,
    JSON.stringify(details),
    client.ip,
    uaHash(client),
  ]);
}

export function createGuests(
  pool: pg.Pool,
  kit: Kit,
  catalog: ResourceCatalog,
  options: GuestsOptions = {},
): Guests {
  const mailer = options.mailer ?? noGuestMail;
  const acceptBase = options.acceptUrl ?? "/guest/accept";

  /** For callers with no identity yet: refusals still become a Result. */
  const anonymous = async <T>(work: (db: Db) => Promise<T>): Promise<Result<T>> => {
    try {
      return ok(await asApp(pool, NOBODY, work));
    } catch (err) {
      const reason = failureOf(err);
      if (reason) return refuse(reason);
      throw err;
    }
  };

  const partyOf = async (db: Db, spaceId: string, partyId: string) => {
    const row = isId(partyId)
      ? await one<PartyRow>(db, `${PARTY_SQL} where p.id = $1 and p.space_id = $2`, [
          partyId,
          spaceId,
        ])
      : null;
    if (!row) throw refusal("NOT_FOUND");
    return partyView(row);
  };

  return {
    async addParty(p, spaceId, input, client) {
      return kit.attempt(p, async (db) => {
        if (!isId(spaceId)) throw refusal("NOT_FOUND");
        await needAdmin(db, spaceId);
        const made = await one<{ id: string }>(
          db,
          "select work.add_party($1, $2, $3, $4::text[]) as id",
          [spaceId, input.name, input.domain, input.connection_admin_emails],
        );
        const id = made?.id ?? "";
        await kit.audit(db, p, client, "space.party_added", "space", spaceId, {
          party_id: id,
          domain: input.domain,
        });
        await kit.activity(db, p, spaceId, "party.added", null, { party_id: id });
        return partyOf(db, spaceId, id);
      });
    },

    async parties(p, spaceId) {
      if (!isId(spaceId)) return null;
      const r = await kit.attempt(p, async (db) => {
        // A guest may not list parties here; they have their own endpoints.
        if (p.guest) return null;
        const room = await one<{ id: string }>(db, "select id from work.space where id = $1", [
          spaceId,
        ]);
        if (!room) return null;
        const rows = await db.query<PartyRow>(
          `${PARTY_SQL} where p.space_id = $1 and p.removed_at is null order by p.created_at`,
          [spaceId],
        );
        return rows.rows.map(partyView);
      });
      return r.ok ? r.value : null;
    },

    async removeParty(p, spaceId, partyId, client) {
      return kit.attempt(p, async (db) => {
        if (!isId(spaceId) || !isId(partyId)) throw refusal("NOT_FOUND");
        await needAdmin(db, spaceId);
        await db.query("select work.remove_party($1, $2)", [spaceId, partyId]);
        await kit.audit(db, p, client, "space.party_removed", "space", spaceId, {
          party_id: partyId,
        });
        await kit.activity(db, p, spaceId, "party.removed", null, { party_id: partyId });
        return null;
      });
    },

    async approve(p, spaceId, partyId, client) {
      return kit.attempt(p, async (db) => {
        if (!isId(spaceId) || !isId(partyId)) throw refusal("NOT_FOUND");
        const row = await one<{ status: string }>(
          db,
          "select work.approve_connection($1, $2) as status",
          [spaceId, partyId],
        );
        const status = row?.status ?? "";
        const details = { party_id: partyId, status };
        if (p.guest) {
          await auditAsSystem(
            db,
            p.workspaceId,
            client,
            "space.connection_approved",
            "space",
            spaceId,
            {
              ...details,
              side: "external",
              guest_id: p.userId,
            },
          );
        } else {
          await kit.audit(db, p, client, "space.connection_approved", "space", spaceId, {
            ...details,
            side: "internal",
          });
        }
        return { status };
      });
    },

    async reject(p, spaceId, partyId, reason, client) {
      return kit.attempt(p, async (db) => {
        if (!isId(spaceId) || !isId(partyId)) throw refusal("NOT_FOUND");
        await db.query("select work.reject_connection($1, $2, $3)", [
          spaceId,
          partyId,
          reason ?? null,
        ]);
        const details = { party_id: partyId, has_reason: Boolean(reason) };
        if (p.guest) {
          await auditAsSystem(
            db,
            p.workspaceId,
            client,
            "space.connection_rejected",
            "space",
            spaceId,
            {
              ...details,
              side: "external",
              guest_id: p.userId,
            },
          );
        } else {
          await kit.audit(db, p, client, "space.connection_rejected", "space", spaceId, {
            ...details,
            side: "internal",
          });
        }
        return null;
      });
    },

    async invite(p, spaceId, input, client) {
      return kit.attempt(p, async (db) => {
        if (!isId(spaceId)) throw refusal("NOT_FOUND");
        await needAdmin(db, spaceId);
        const token = randomBytes(32).toString("base64url");
        const made = await one<{ id: string }>(
          db,
          "select work.invite_guest($1, $2, $3, $4) as id",
          [spaceId, input.email, sha256(token), input.access_days],
        );
        const id = made?.id ?? "";
        await kit.audit(db, p, client, "space.guest_invited", "space", spaceId, {
          invite_id: id,
          access_days: input.access_days,
        });
        await kit.activity(db, p, spaceId, "guest.invited", null, { invite_id: id });
        return {
          id,
          email: input.email,
          accessDays: input.access_days,
          token,
          acceptUrl: `${acceptBase}#token=${token}`,
        };
      });
    },

    async guests(p, spaceId) {
      return kit.attempt(p, async (db) => {
        if (!isId(spaceId)) throw refusal("NOT_FOUND");
        await needAdmin(db, spaceId);
        const rows = await db.query<{
          user_id: string;
          email: string;
          name: string;
          party_id: string | null;
          expires_at: Date;
          status: GuestView["status"];
        }>("select * from work.space_guests($1)", [spaceId]);
        return rows.rows.map((g) => ({
          userId: g.user_id,
          email: g.email,
          name: g.name,
          partyId: g.party_id,
          expiresAt: g.expires_at.toISOString(),
          status: g.status,
        }));
      });
    },

    async removeGuest(p, spaceId, userId, client) {
      return kit.attempt(p, async (db) => {
        if (!isId(spaceId) || !isId(userId)) throw refusal("NOT_FOUND");
        await needAdmin(db, spaceId);
        await db.query("select work.remove_guest($1, $2)", [spaceId, userId]);
        await kit.audit(db, p, client, "space.guest_removed", "space", spaceId, {
          user_id: userId,
        });
        await kit.activity(db, p, spaceId, "guest.removed", null, { user_id: userId });
        return null;
      });
    },

    async preview(token) {
      const r = await anonymous(async (db) =>
        one<{
          email: string;
          space_name: string;
          workspace_name: string;
          party_name: string;
          expires_at: Date;
        }>(db, "select * from work.preview_guest_invite($1)", [sha256(token)]),
      );
      if (!r.ok || !r.value) return null;
      return {
        email: r.value.email,
        spaceName: r.value.space_name,
        workspaceName: r.value.workspace_name,
        partyName: r.value.party_name,
        expiresAt: r.value.expires_at.toISOString(),
      };
    },

    async accept(token, name, client) {
      return anonymous(async (db) => {
        const row = await one<{
          user_id: string;
          workspace_id: string;
          workspace_slug: string;
          space_id: string;
        }>(db, "select * from work.accept_guest_invite($1, $2)", [sha256(token), name]);
        if (!row) throw refusal("INVITE_INVALID");
        await auditAsSystem(
          db,
          row.workspace_id,
          client,
          "space.guest_joined",
          "space",
          row.space_id,
          {
            guest_id: row.user_id,
          },
        );
        return {
          userId: row.user_id,
          workspaceId: row.workspace_id,
          workspaceSlug: row.workspace_slug,
          spaceId: row.space_id,
        };
      });
    },

    async requestCode(workspace, email, client) {
      const address = email.toLowerCase();
      const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
      const issued = await asApp(pool, NOBODY, async (db) => {
        const row = await one<{
          user_id: string | null;
          workspace_id: string | null;
          issued: boolean;
        }>(db, "select * from core.issue_guest_code($1, $2, $3)", [
          workspace,
          address,
          codeHash(workspace, address, code),
        ]);
        if (!row?.issued || !row.workspace_id) return false;
        await auditAsSystem(
          db,
          row.workspace_id,
          client,
          "guest.login_code_issued",
          "user",
          row.user_id,
          {
            guest_id: row.user_id,
          },
        );
        return true;
      });
      // After the commit, so a code is never sent for one that rolled back.
      if (issued) await mailer.sendCode({ workspace, email: address }, code).catch(() => {});
    },

    async verifyCode(workspace, email, code, client) {
      const address = email.toLowerCase();
      return asApp(pool, NOBODY, async (db) => {
        const row = await one<{
          user_id: string | null;
          workspace_id: string | null;
          ok: boolean;
          reason: string | null;
        }>(db, "select * from core.verify_guest_code($1, $2, $3)", [
          workspace,
          address,
          codeHash(workspace, address, code),
        ]);
        if (!row) return null;
        if (!row.ok || !row.user_id || !row.workspace_id) {
          // No workspace means no audit log to write to.
          if (row.workspace_id) {
            await auditAsSystem(
              db,
              row.workspace_id,
              client,
              "guest.login_failed",
              "user",
              row.user_id,
              {
                guest_id: row.user_id,
                reason: row.reason ?? "invalid",
              },
            );
          }
          return null;
        }
        const token = randomBytes(32).toString("base64url");
        // As the guest: the session policy lets a live guest make and read only their own.
        await actAs(db, { userId: row.user_id, workspaceId: row.workspace_id });
        const made = await one<{ id: string }>(
          db,
          `insert into core.session (workspace_id, user_id, token_hash, expires_at, ip, ua_hash)
           values ($1, $2, $3, now() + make_interval(secs => $4), $5, $6) returning id`,
          [
            row.workspace_id,
            row.user_id,
            sha256(token),
            GUEST_SESSION_SECONDS,
            client.ip,
            uaHash(client),
          ],
        );
        const sessionId = made?.id ?? "";
        await auditAsSystem(
          db,
          row.workspace_id,
          client,
          "guest.login_succeeded",
          "session",
          sessionId,
          {
            guest_id: row.user_id,
          },
        );
        return {
          token,
          principal: {
            sessionId,
            userId: row.user_id,
            workspaceId: row.workspace_id,
            guest: true,
          },
        };
      });
    },

    async mySpaces(p) {
      const r = await kit.attempt(p, async (db) => {
        if (!p.guest) return [];
        const rows = await db.query<{
          space_id: string;
          space_name: string;
          party_id: string;
          party_name: string;
          connection_status: string;
          can_approve: boolean;
          expires_at: Date;
        }>("select * from work.my_guest_spaces()");
        return rows.rows.map((s) => ({
          spaceId: s.space_id,
          spaceName: s.space_name,
          partyId: s.party_id,
          partyName: s.party_name,
          connectionStatus: s.connection_status,
          canApprove: s.can_approve,
          expiresAt: s.expires_at.toISOString(),
        }));
      });
      return r.ok ? r.value : [];
    },

    async space(p, spaceId, client) {
      return kit.attempt(p, async (db) => {
        if (!p.guest || !isId(spaceId)) throw refusal("NOT_FOUND");
        // Read as the guest, so the policies decide: nothing before the connection is approved.
        const space = await one<{ id: string; name: string }>(
          db,
          "select id, name from work.space where id = $1",
          [spaceId],
        );
        const party = space
          ? await one<{ id: string; name: string }>(
              db,
              "select id, name from work.space_party where id = work.my_party($1)",
              [spaceId],
            )
          : null;
        if (!space || !party) throw refusal("NOT_FOUND");
        const workspace = await one<{ name: string }>(db, "select name from core.workspace", []);
        const rows = await db.query<{
          id: string;
          resource_type: keyof ResourceCatalog;
          resource_id: string;
          access: string;
        }>(
          `select r.id, r.resource_type, r.resource_id, work.guest_level(r.space_id, r.per_party) as access
             from work.space_resource r where r.space_id = $1 order by r.created_at, r.id`,
          [spaceId],
        );
        const resources = [];
        for (const r of rows.rows) {
          const lookup = catalog[r.resource_type];
          const found = lookup ? await lookup(db, r.resource_id) : null;
          resources.push({
            id: r.id,
            resourceType: r.resource_type,
            resourceId: r.resource_id,
            name: found?.name ?? null,
            access: r.access,
          });
        }
        await auditAsSystem(db, p.workspaceId, client, "space.external_access", "space", spaceId, {
          guest_id: p.userId,
          party_id: party.id,
          resource_ids: resources.slice(0, 100).map((r) => r.resourceId),
        });
        return {
          space: {
            id: space.id,
            name: space.name,
            kind: "external" as const,
            workspaceName: workspace?.name ?? null,
          },
          party,
          resources,
        };
      });
    },
  };
}
