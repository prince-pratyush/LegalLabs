import { createHash } from "node:crypto";
import type { Scanner } from "@legallabs/ingest";
import type pg from "pg";
import { asWorker } from "../db.js";
import type { Documents } from "../documents/documents.js";
import { type InboundAttachment, type InboundMessage, readEmail, senderHash } from "./email.js";
import { inboxFiling, NotYet } from "./filing.js";

// Reads the queue of received mail. Each message becomes one request, with the message itself
// and its files filed in the Inbox by the intake service user, through the same upload,
// scan and ingest path as any file. No mail is ever sent from here (see intake/worker.ts).

export interface EmailProcessorOptions {
  documents: Pick<Documents, "upload">;
  /** Every file is scanned before it is stored; the ingest worker scans again. */
  scanner: Scanner;
  /** Messages taken per workspace in any hour. The rest stay queued. */
  perHour?: number;
  /** Messages taken from one sender per channel in any hour. The rest stay queued. */
  senderPerHour?: number;
  maxAttempts?: number;
  intervalMs?: number;
  /** Ids and reasons only: never an address, a name or any text. */
  log?: (line: string) => void;
}

interface Claim {
  id: string;
  workspace_id: string;
  channel_id: string;
  service_user_id: string;
  vault_id: string;
  raw: Buffer;
  address: string;
  authserv_id: string;
  allowed_domains: string[];
  attempt: number;
  lease: string;
}

/** The message's own file; its attachments are numbered from one. */
const MESSAGE_PART = 0;
const BATCH = 25;
const LEASE_SECONDS = 300;

const sha = (...parts: (string | Buffer)[]) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\n");
  return hash.digest();
};

function messageFile(message: InboundMessage, dropped: readonly string[]): Uint8Array {
  const lines = [
    `From: ${message.fromName} <${message.from}>`,
    `Date: ${message.date}`,
    `Subject: ${message.subject}`,
    "",
    message.body,
  ];
  if (dropped.length > 0) lines.push("", "Files not kept:", ...dropped.map((d) => `- ${d}`));
  return Buffer.from(`${lines.join("\n")}\n`);
}

export function createEmailProcessor(pool: pg.Pool, options: EmailProcessorOptions) {
  const { documents, scanner } = options;
  const perHour = options.perHour ?? 600;
  const senderPerHour = options.senderPerHour ?? 30;
  const maxAttempts = options.maxAttempts ?? 10;
  const log = options.log ?? (() => {});

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

  const inbox = inboxFiling(documents, scanner);

  async function handle(job: Claim) {
    const read = await readEmail(job.raw, {
      address: job.address,
      authservId: job.authserv_id,
      allowedDomains: job.allowed_domains,
    });
    if (!read.ok) return refuse(job, "rejected", read.reason);
    const { message } = read;
    const [begun] = await query<{ outcome: string }>(
      "select apps.begin_inbound_email($1, $2, $3, $4, $5) outcome",
      [
        job.id,
        job.lease,
        senderHash(job.workspace_id, message.from),
        sha(job.channel_id, message.from, message.messageId ?? sha(job.raw)),
        senderPerHour,
      ],
    );
    if (begun?.outcome === "duplicate") return refuse(job, "rejected", "duplicate");
    if (begun?.outcome === "defer") return postpone(job, 600, false);
    if (begun?.outcome !== "ok") return;

    const done = new Set(
      (
        await query<{ part_no: number }>("select apps.inbound_email_parts($1) part_no", [job.id])
      ).map((row) => row.part_no),
    );
    // Every file is judged before any is stored, so a scanner that is down stores nothing.
    const judged: { part: number; file: InboundAttachment; why: string | null }[] = [];
    for (const [index, attachment] of message.attachments.entries()) {
      const part = index + 1;
      const why = done.has(part) ? null : await inbox.unwanted(attachment);
      judged.push({ part, file: attachment, why });
    }
    for (const one of judged) {
      if (one.why === null && !done.has(one.part)) {
        one.why = await inbox.file(job, one.part, one.file.name, one.file.bytes);
      }
    }
    const dropped = judged.filter((j) => j.why !== null);
    if (!done.has(MESSAGE_PART)) {
      const why = await inbox.file(
        job,
        MESSAGE_PART,
        "Email message.txt",
        messageFile(
          message,
          dropped.map((j) => `${j.file.name} (${j.why})`),
        ),
      );
      if (why) return refuse(job, "failed", "message_unreadable");
    }
    const kept = judged.length - dropped.length;
    // An answer to our own question joins its request; anything else starts one.
    if (message.replyTokens.length > 0) {
      const [joined] = await query<{ id: string | null }>(
        "select apps.append_inbound_reply($1, $2, $3, $4, $5) id",
        [job.id, job.lease, message.from, message.replyTokens, kept],
      );
      if (joined?.id) return;
    }
    await query("select apps.file_inbound_email($1, $2, $3, $4, $5)", [
      job.id,
      job.lease,
      message.fromName,
      message.from,
      kept,
    ]);
  }

  async function claim(only: string[]): Promise<Claim | undefined> {
    const [job] = await query<Claim>("select * from apps.claim_inbound_email($1, $2, $3, $4)", [
      LEASE_SECONDS,
      perHour,
      maxAttempts,
      only.length > 0 ? only : null,
    ]);
    return job;
  }

  /**
   * Reads what is due, taking workspaces in turn. Tests name workspaces to keep to their own
   * mail.
   */
  async function tick(...only: string[]): Promise<void> {
    for (let n = 0; n < BATCH; n++) {
      const job = await claim(only);
      if (!job) return;
      try {
        await handle(job);
      } catch (err) {
        if (err instanceof NotYet) {
          log(`inbound email ${job.id} waiting: ${err.why}`);
          await postpone(job, err.seconds, false);
          continue;
        }
        // The code or class only: a message may quote what was being stored.
        const { code } = err as { code?: string };
        log(`inbound email ${job.id} failed: ${code ?? (err as Error).constructor.name}`);
        if (job.attempt >= maxAttempts) await refuse(job, "failed", "processing_failed");
        else await postpone(job, Math.min(60 * 2 ** (job.attempt - 1), 21_600), true);
      }
    }
  }

  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  const guarded = () => {
    running ??= tick()
      .catch((err) => log(`inbound email pass failed: ${(err as { code?: string }).code ?? ""}`))
      .finally(() => {
        running = null;
      });
    return running;
  };

  return {
    tick,
    start() {
      timer ??= setInterval(() => void guarded(), options.intervalMs ?? 5000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
