import { randomBytes } from "node:crypto";
import type {
  IntakeSlackChannel,
  IntakeSlackChannelCreate,
  IntakeSlackChannelPatch,
} from "@legallabs/contracts";
import type pg from "pg";
import type { z } from "zod";
import type { SecretBox } from "../admin-models/secrets.js";
import type { Client, Principal } from "../auth/auth.js";
import { asWorker } from "../db.js";
import {
  type ChannelResult,
  channelAudit,
  managed,
  refuse,
  roomForChannel,
  UUID,
} from "./channel-admin.js";

// A workspace's Slack channels. Slack makes both secrets, so they are typed in here, sealed
// like any other stored secret and never given back.

type Create = z.output<typeof IntakeSlackChannelCreate>;
type Patch = z.output<typeof IntakeSlackChannelPatch>;

export interface OpenSlackChannel {
  id: string;
  workspaceId: string;
  teamId: string;
  channelIds: string[];
  signingSecret: string;
}

export interface SlackChannels {
  list(principal: Principal): Promise<ChannelResult<IntakeSlackChannel[]>>;
  create(
    principal: Principal,
    input: Create,
    client: Client,
  ): Promise<ChannelResult<IntakeSlackChannel>>;
  update(
    principal: Principal,
    id: string,
    patch: Patch,
    client: Client,
  ): Promise<ChannelResult<IntakeSlackChannel>>;
  /** For the hook: the live channel at this key. */
  open(key: string): Promise<OpenSlackChannel | null>;
  /** For the hook, after the signature. `thread` is given for an answer in one. */
  receive(
    channelId: string,
    raw: Buffer,
    fromHash: Buffer,
    thread: { channel: string; threadTs: string | null; user: string } | null,
  ): Promise<"queued" | "duplicate" | "full" | "ignored" | "unknown">;
}

const COLUMNS = `id, name, team_id, slack_channel_ids, (bot_token_sealed is not null) has_bot_token,
  status, key, created_at, updated_at`;

interface Row {
  id: string;
  name: string;
  team_id: string;
  slack_channel_ids: string[];
  has_bot_token: boolean;
  status: "live" | "disabled";
  key: string;
  created_at: Date;
  updated_at: Date;
}

const toChannel = (row: Row): IntakeSlackChannel => ({
  id: row.id,
  name: row.name,
  team_id: row.team_id,
  channel_ids: row.slack_channel_ids,
  has_bot_token: row.has_bot_token,
  status: row.status,
  hook_path: `/hooks/slack/${row.key}`,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
});

export function createSlackChannels(
  pool: pg.Pool,
  options: { secrets?: SecretBox } = {},
): SlackChannels {
  const { secrets } = options;
  const seal = (value: string) => (secrets ?? refuse("SECRETS_UNAVAILABLE")).seal(value);

  return {
    list(principal) {
      return managed(pool, principal, async (db) => {
        const { rows } = await db.query<Row>(
          `select ${COLUMNS} from apps.intake_channel where kind = 'slack' order by lower(name)`,
        );
        return rows.map(toChannel);
      });
    },

    create(principal, input, client) {
      return managed(pool, principal, async (db) => {
        const secret = seal(input.signing_secret);
        const token = input.bot_token ? seal(input.bot_token) : null;
        await roomForChannel(db);
        // The Inbox and its service account must exist before anything can be filed.
        await db.query("select from apps.ensure_intake_inbox()");
        const { rows } = await db.query<Row>(
          `insert into apps.intake_channel (workspace_id, kind, key, name, team_id,
             slack_channel_ids, secret_sealed, bot_token_sealed, created_by)
           values ($1, 'slack', $2, $3, $4, $5, $6, $7, $8) returning ${COLUMNS}`,
          [
            principal.workspaceId,
            randomBytes(24).toString("base64url"),
            input.name,
            input.team_id,
            input.channel_ids,
            secret,
            token,
            principal.userId,
          ],
        );
        const row = rows[0] as Row;
        await channelAudit(
          db,
          principal,
          "intake.channel.created",
          row.id,
          { kind: "slack" },
          client,
        );
        return toChannel(row);
      });
    },

    update(principal, id, patch, client) {
      return managed(pool, principal, async (db) => {
        if (!UUID.test(id)) refuse("NOT_FOUND");
        const before = await db.query<Row>(
          `select ${COLUMNS} from apps.intake_channel
            where id = $1 and kind = 'slack' for update`,
          [id],
        );
        const was = before.rows[0] ?? refuse("NOT_FOUND");
        const sets: [string, unknown][] = [];
        if (patch.name !== undefined) sets.push(["name", patch.name]);
        if (patch.team_id !== undefined) sets.push(["team_id", patch.team_id]);
        if (patch.channel_ids !== undefined) sets.push(["slack_channel_ids", patch.channel_ids]);
        if (patch.status !== undefined) sets.push(["status", patch.status]);
        if (patch.signing_secret !== undefined) {
          sets.push(["secret_sealed", seal(patch.signing_secret)]);
        }
        if (patch.bot_token !== undefined) {
          sets.push(["bot_token_sealed", patch.bot_token ? seal(patch.bot_token) : null]);
        }
        const { rows } = await db.query<Row>(
          `update apps.intake_channel
              set ${sets.map(([column], i) => `${column} = $${i + 2}`).join(", ")},
                  updated_at = now()
            where id = $1 returning ${COLUMNS}`,
          [id, ...sets.map(([, value]) => value)],
        );
        const row = rows[0] ?? refuse("NOT_FOUND");
        // What decides who may send is audited with both values; no secret ever is.
        const trust = ["team_id", "slack_channel_ids", "status"] as const;
        const changed = trust.filter((column) => sets.some(([set]) => set === column));
        await channelAudit(
          db,
          principal,
          "intake.channel.updated",
          id,
          {
            changed: Object.keys(patch),
            before: Object.fromEntries(changed.map((k) => [k, was[k]])),
            after: Object.fromEntries(changed.map((k) => [k, row[k]])),
          },
          client,
        );
        return toChannel(row);
      });
    },

    async open(key) {
      if (!secrets) return null;
      const row = await asWorker(pool, async (db) => {
        const { rows } = await db.query<{
          id: string;
          workspace_id: string;
          team_id: string;
          slack_channel_ids: string[];
          secret_sealed: Buffer;
        }>("select * from apps.open_slack_channel($1)", [key]);
        return rows[0];
      });
      if (!row) return null;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        teamId: row.team_id,
        channelIds: row.slack_channel_ids,
        signingSecret: secrets.open(row.secret_sealed),
      };
    },

    receive(channelId, raw, fromHash, thread) {
      return asWorker(pool, async (db) => {
        const { rows } = await db.query<{
          outcome: "queued" | "duplicate" | "full" | "ignored" | "unknown";
        }>("select apps.receive_slack_event($1, $2, $3, $4, $5, $6) outcome", [
          channelId,
          raw,
          fromHash,
          thread?.channel ?? null,
          thread?.threadTs ?? null,
          thread?.user ?? null,
        ]);
        return rows[0]?.outcome ?? "unknown";
      });
    },
  };
}
