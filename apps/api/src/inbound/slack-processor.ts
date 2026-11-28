import { createHash } from "node:crypto";
import type { Scanner } from "@legallabs/ingest";
import type pg from "pg";
import type { SecretBox } from "../admin-models/secrets.js";
import { asWorker } from "../db.js";
import type { Documents } from "../documents/documents.js";
import type { SlackApi } from "../intake/slack-api.js";
import { senderHash } from "./email.js";
import { inboxFiling, NotYet } from "./filing.js";
import { SLACK_LIMITS, type SlackItem } from "./slack.js";

// Reads the queue of what Slack posted. Each new message becomes one request, with the message
// itself and its files filed in the Inbox, and an answer in a thread joins its request. Files
// are fetched only with the channel's bot token. Nothing is posted from here
// (see intake/slack-post.ts).

export interface SlackProcessorOptions {
  documents: Pick<Documents, "upload">;
  scanner: Scanner;
  /** Without one no token can be opened, so no file is fetched. */
  secrets?: SecretBox;
  api: SlackApi;
  /** Messages taken per workspace in any hour. The rest stay queued. */
  perHour?: number;
  /** Messages taken from one sender per channel in any hour. The rest stay queued. */
  senderPerHour?: number;
  maxAttempts?: number;
  intervalMs?: number;
  /** Ids and reasons only: never a name or any text. */
  log?: (line: string) => void;
}

interface Claim {
  id: string;
  workspace_id: string;
  channel_id: string;
  service_user_id: string;
  vault_id: string;
  raw: Buffer;
  bot_token_sealed: Buffer | null;
  attempt: number;
  lease: string;
}

/** The message's own file; its attachments are numbered from one. */
const MESSAGE_PART = 0;
const BATCH = 25;
const LEASE_SECONDS = 300;

const sha = (...parts: string[]) => createHash("sha256").update(parts.join("\n")).digest();

function messageFile(item: SlackItem, dropped: readonly string[]): Uint8Array {
  const { author } = item;
  const who = author?.user ? `Slack user ${author.user}` : "someone Slack did not name";
  const from = author
    ? [
        `Written by ${who}${author.outside ? `, outside this workspace (team ${author.team})` : ""}`,
        `Submitted by ${item.name} (Slack ${item.user})`,
      ]
    : [`From: ${item.name} (Slack ${item.user})`];
  const lines = [...from, `Slack channel: ${item.channel}`, "", item.text];
  if (dropped.length > 0) lines.push("", "Files not kept:", ...dropped.map((d) => `- ${d}`));
  return Buffer.from(`${lines.join("\n")}\n`);
}

export function createSlackProcessor(pool: pg.Pool, options: SlackProcessorOptions) {
  const { documents, scanner, secrets, api } = options;
  const perHour = options.perHour ?? 600;
  const senderPerHour = options.senderPerHour ?? 30;
  const maxAttempts = options.maxAttempts ?? 10;
  const log = options.log ?? (() => {});
  const inbox = inboxFiling(documents, scanner);

  const query = <T extends pg.QueryResultRow>(sql: string, params: unknown[]) =>
    asWorker(pool, async (db) => (await db.query<T>(sql, params)).rows);

  const refuse = (job: Claim, status: "rejected" | "failed", reason: string) =>
    query("select apps.refuse_inbound_email($1, $2, $3, $4)", [job.id, job.lease, status, reason]);
  const postpone = (job: Claim, seconds: number, counts: boolean) =>
    query("select apps.postpone_inbound_email($1, $2, $3, $4)", [
      job.id,
      job.lease,
      seconds,
      counts,
    ]);

  const partsFiled = async (job: Claim) =>
    new Set(
      (
        await query<{ part_no: number }>("select apps.inbound_email_parts($1) part_no", [job.id])
      ).map((row) => row.part_no),
    );

  /** Files what can be kept of a message's attachments, and says why of the rest. */
  async function attachments(job: Claim, item: SlackItem, filed: Set<number>) {
    const token = job.bot_token_sealed && secrets ? secrets.open(job.bot_token_sealed) : undefined;
    const dropped: string[] = [];
    let kept = 0;
    let left: number = SLACK_LIMITS.file_bytes;
    for (const [index, file] of item.files.entries()) {
      const part = index + 1;
      if (filed.has(part)) {
        kept++;
        continue;
      }
      let why: string | null = null;
      if (!token || !file.url) why = "not fetched";
      else if (file.size > left) why = "too large";
      else {
        const got = await api.download(token, { url: file.url, html: file.html }, left);
        if (!got.ok) why = got.why;
        else {
          left -= got.bytes.length;
          why = await inbox.unwanted({ name: file.name, bytes: got.bytes });
          why ??= await inbox.file(job, part, file.name, got.bytes);
        }
      }
      if (why) dropped.push(`${file.name} (${why})`);
      else kept++;
    }
    return { kept, dropped };
  }

  async function handle(job: Claim) {
    const item = JSON.parse(job.raw.toString("utf8")) as SlackItem;
    // One message is one request from each person, however it arrived: as an event or by their
    // shortcut.
    const which = item.ts ?? item.trigger ?? "";
    const [begun] = await query<{ outcome: string }>(
      "select apps.begin_inbound_email($1, $2, $3, $4, $5) outcome",
      [
        job.id,
        job.lease,
        senderHash(job.workspace_id, item.user),
        sha(job.channel_id, item.channel, which, item.user),
        senderPerHour,
      ],
    );
    if (begun?.outcome === "duplicate") return refuse(job, "rejected", "duplicate");
    if (begun?.outcome === "defer") return postpone(job, 600, false);
    if (begun?.outcome !== "ok") return;

    const filed = await partsFiled(job);
    // An answer to a request that has since closed is dropped before anything is stored. One
    // part way filed goes on, and joins its request whatever its state now.
    if (item.reply && filed.size === 0) {
      const [thread] = await query<{ id: string | null }>(
        "select apps.slack_thread_request($1, $2, $3, $4) id",
        [job.channel_id, item.channel, item.threadTs, item.user],
      );
      if (!thread?.id) return refuse(job, "rejected", "request_closed");
    }
    const { kept, dropped } = await attachments(job, item, filed);
    if (!filed.has(MESSAGE_PART)) {
      const why = await inbox.file(
        job,
        MESSAGE_PART,
        "Slack message.txt",
        messageFile(item, dropped),
      );
      if (why) return refuse(job, "failed", "message_unreadable");
    }
    if (item.reply) {
      // An answer never starts a request.
      await query("select apps.append_slack_reply($1, $2, $3, $4, $5, $6)", [
        job.id,
        job.lease,
        item.user,
        item.channel,
        item.threadTs,
        kept,
      ]);
      return;
    }
    await query("select apps.file_slack_event($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
      job.id,
      job.lease,
      item.user,
      item.name,
      item.threadTs ? item.channel : null,
      item.threadTs,
      kept,
      item.author?.user ?? null,
      item.author?.outside ?? false,
    ]);
  }

  async function claim(only: string[]): Promise<Claim | undefined> {
    const [job] = await query<Claim>("select * from apps.claim_slack_event($1, $2, $3, $4)", [
      LEASE_SECONDS,
      perHour,
      maxAttempts,
      only.length > 0 ? only : null,
    ]);
    return job;
  }

  /** Reads what is due, taking workspaces in turn. Tests name workspaces to keep to their own. */
  async function tick(...only: string[]): Promise<void> {
    for (let n = 0; n < BATCH; n++) {
      const job = await claim(only);
      if (!job) return;
      try {
        await handle(job);
      } catch (err) {
        if (err instanceof NotYet) {
          log(`inbound slack ${job.id} waiting: ${err.why}`);
          await postpone(job, err.seconds, false);
          continue;
        }
        // The code or class only: a message may quote what was being stored.
        const { code } = err as { code?: string };
        log(`inbound slack ${job.id} failed: ${code ?? (err as Error).constructor.name}`);
        if (job.attempt >= maxAttempts) await refuse(job, "failed", "processing_failed");
        else await postpone(job, Math.min(60 * 2 ** (job.attempt - 1), 21_600), true);
      }
    }
  }

  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  const guarded = () => {
    running ??= tick()
      .catch((err) => log(`inbound slack pass failed: ${(err as { code?: string }).code ?? ""}`))
      .finally(() => {
        running = null;
      });
    return running;
  };

  return {
    tick,
    start() {
      timer ??= setInterval(() => void guarded(), options.intervalMs ?? 2000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
