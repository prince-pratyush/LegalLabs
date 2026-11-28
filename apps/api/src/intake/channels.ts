import { randomBytes } from "node:crypto";
import type {
  IntakeEmailChannel,
  IntakeEmailChannelCreate,
  IntakeEmailChannelPatch,
} from "@legallabs/contracts";
import type pg from "pg";
import type { z } from "zod";
import type { SecretBox } from "../admin-models/secrets.js";
import type { Client, Principal } from "../auth/auth.js";
import { asWorker } from "../db.js";
import type { EmailRules } from "../inbound/email.js";
import {
  type ChannelFailure,
  type ChannelResult,
  channelAudit,
  managed,
  refuse,
  roomForChannel,
  UUID,
} from "./channel-admin.js";

// The workspace's intake addresses. Each has a secret the receiving mail server signs with,
// sealed like any other stored secret and shown only when it is made.

export type { ChannelFailure, ChannelResult };

type Create = z.output<typeof IntakeEmailChannelCreate>;
type Patch = z.output<typeof IntakeEmailChannelPatch>;
type Made = { channel: IntakeEmailChannel; secret: string };

export interface EmailChannels {
  list(principal: Principal): Promise<ChannelResult<IntakeEmailChannel[]>>;
  create(principal: Principal, input: Create, client: Client): Promise<ChannelResult<Made>>;
  update(
    principal: Principal,
    id: string,
    patch: Patch,
    client: Client,
  ): Promise<ChannelResult<IntakeEmailChannel>>;
  rotate(
    principal: Principal,
    id: string,
    graceHours: number,
    client: Client,
  ): Promise<ChannelResult<Made>>;
  /** For the hook: the live channel at this key and the secrets that sign for it now. */
  open(key: string): Promise<OpenChannel | null>;
  /** For the hook, after the signature: queues a message, or records that it was refused. */
  receive(
    channelId: string,
    raw: Buffer,
    verdict: { fromHash: Buffer } | { rejected: string },
  ): Promise<Received>;
}

export interface OpenChannel {
  id: string;
  workspaceId: string;
  secrets: string[];
  rules: EmailRules;
}

type Received = "queued" | "rejected" | "duplicate" | "full" | "unknown";

/** Settings that decide who may send, so a change to one is audited with both values. */
const TRUST = ["allowed_domains", "authserv_id", "status"] as const;

export interface EmailChannelsOptions {
  /** Without one no secret can be kept, so there are no channels to post to. */
  secrets?: SecretBox;
  now?: () => number;
}

const COLUMNS = `id, name, address, authserv_id, allowed_domains, status, key,
  previous_secret_until, created_at, updated_at`;

interface Row
  extends Omit<
    IntakeEmailChannel,
    "hook_path" | "previous_secret_until" | "created_at" | "updated_at"
  > {
  key: string;
  previous_secret_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

const toChannel = ({ key, ...row }: Row): IntakeEmailChannel => ({
  ...row,
  hook_path: `/hooks/email/${key}`,
  previous_secret_until: row.previous_secret_until?.toISOString() ?? null,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
});

export function createEmailChannels(
  pool: pg.Pool,
  options: EmailChannelsOptions = {},
): EmailChannels {
  const { secrets, now = Date.now } = options;

  const newSecret = () => {
    const box = secrets ?? refuse("SECRETS_UNAVAILABLE");
    const secret = randomBytes(32).toString("base64url");
    return { secret, sealed: box.seal(secret) };
  };

  return {
    list(principal) {
      return managed(pool, principal, async (db) => {
        const { rows } = await db.query<Row>(
          `select ${COLUMNS} from apps.intake_channel where kind = 'email' order by lower(name)`,
        );
        return rows.map(toChannel);
      });
    },

    create(principal, input, client) {
      return managed(pool, principal, async (db) => {
        const { secret, sealed } = newSecret();
        await roomForChannel(db);
        // The Inbox and its service account must exist before any mail can be filed.
        await db.query("select from apps.ensure_intake_inbox()");
        const { rows } = await db.query<Row>(
          `insert into apps.intake_channel (workspace_id, key, name, address, authserv_id,
             allowed_domains, secret_sealed, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${COLUMNS}`,
          [
            principal.workspaceId,
            randomBytes(24).toString("base64url"),
            input.name,
            input.address,
            input.authserv_id,
            input.allowed_domains,
            sealed,
            principal.userId,
          ],
        );
        const row = rows[0] as Row;
        await channelAudit(
          db,
          principal,
          "intake.channel.created",
          row.id,
          { kind: "email" },
          client,
        );
        return { channel: toChannel(row), secret };
      });
    },

    update(principal, id, patch, client) {
      return managed(pool, principal, async (db) => {
        if (!UUID.test(id)) refuse("NOT_FOUND");
        // The keys are the schema's own, so each is a column name.
        const changed = Object.entries(patch).filter(([, value]) => value !== undefined);
        const before = await db.query<Row>(
          `select ${COLUMNS} from apps.intake_channel
            where id = $1 and kind = 'email' for update`,
          [id],
        );
        const was = before.rows[0] ?? refuse("NOT_FOUND");
        const { rows } = await db.query<Row>(
          `update apps.intake_channel
              set ${changed.map(([column], i) => `${column} = $${i + 2}`).join(", ")},
                  updated_at = now()
            where id = $1 returning ${COLUMNS}`,
          [id, ...changed.map(([, value]) => value)],
        );
        const row = rows[0] ?? refuse("NOT_FOUND");
        await channelAudit(
          db,
          principal,
          "intake.channel.updated",
          id,
          {
            changed: changed.map(([column]) => column),
            before: Object.fromEntries(TRUST.filter((k) => k in patch).map((k) => [k, was[k]])),
            after: Object.fromEntries(TRUST.filter((k) => k in patch).map((k) => [k, row[k]])),
          },
          client,
        );
        return toChannel(row);
      });
    },

    rotate(principal, id, graceHours, client) {
      return managed(pool, principal, async (db) => {
        if (!UUID.test(id)) refuse("NOT_FOUND");
        const { secret, sealed } = newSecret();
        const until = graceHours > 0 ? new Date(now() + graceHours * 3_600_000) : null;
        const { rows } = await db.query<Row>(
          `update apps.intake_channel
              set previous_secret_sealed =
                    case when $3::timestamptz is null then null else secret_sealed end,
                  previous_secret_until = $3, secret_sealed = $2, updated_at = now()
            where id = $1 and kind = 'email' returning ${COLUMNS}`,
          [id, sealed, until],
        );
        const row = rows[0] ?? refuse("NOT_FOUND");
        await channelAudit(
          db,
          principal,
          "intake.channel.secret_rotated",
          id,
          { grace_hours: graceHours },
          client,
        );
        return { channel: toChannel(row), secret };
      });
    },

    async open(key) {
      if (!secrets) return null;
      const row = await asWorker(pool, async (db) => {
        const { rows } = await db.query<{
          id: string;
          workspace_id: string;
          address: string;
          authserv_id: string;
          allowed_domains: string[];
          secret_sealed: Buffer;
          previous_secret_sealed: Buffer | null;
          previous_secret_until: Date | null;
        }>("select * from apps.open_email_channel($1)", [key]);
        return rows[0];
      });
      if (!row) return null;
      const sealed = [row.secret_sealed];
      if (row.previous_secret_sealed && (row.previous_secret_until?.getTime() ?? 0) > now()) {
        sealed.push(row.previous_secret_sealed);
      }
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        secrets: sealed.map((s) => secrets.open(s)),
        rules: {
          address: row.address,
          authservId: row.authserv_id,
          allowedDomains: row.allowed_domains,
        },
      };
    },

    receive(channelId, raw, verdict) {
      return asWorker(pool, async (db) => {
        const { rows } = await db.query<{ outcome: Received }>(
          "select apps.receive_inbound_email($1, $2, $3, $4) outcome",
          [
            channelId,
            raw,
            "fromHash" in verdict ? verdict.fromHash : null,
            "rejected" in verdict ? verdict.rejected : null,
          ],
        );
        return rows[0]?.outcome ?? "unknown";
      });
    },
  };
}
