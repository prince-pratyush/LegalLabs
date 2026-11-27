import type pg from "pg";
import { asWorker } from "../db.js";
import type { EmailMessage, EmailProvider } from "../notifications/email-port.js";

// Mail to a requester. The words are fixed here, apart from a type's own question and a
// lawyer's own reply: nothing a requester or a model wrote is ever sent out, and there is no
// link, since a requester has nothing to sign in to.

export interface IntakeMail {
  provider: EmailProvider;
  /** Mails to one address in any hour. */
  perHour?: number;
}

export interface MailRow {
  id: string;
  lease: string;
  attempt: number;
  kind: "ask" | "assigned" | "done" | "reply" | "reminder" | "no_response" | "merged";
  body: string | null;
  token: string;
  request_id: string;
  number: number;
  email: string;
  address: string;
  author_name: string | null;
  assignee_name: string | null;
  prompt: string | null;
  label: string | null;
}

const MAX_ATTEMPTS = 5;
const BATCH = 25;

/** A name or label on one line, so it can add nothing of its own to a header or a layout. */
const line = (text: string | null) =>
  (text ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();

const SUBJECTS: Record<MailRow["kind"], string> = {
  ask: "We need one more detail",
  reminder: "We are still waiting for a detail",
  assigned: "Your request has been assigned",
  done: "Your request is complete",
  reply: "A reply to your request",
  no_response: "Your request has been closed",
  merged: "Your request has been combined",
};

function text(row: MailRow): string {
  const request = `request #${row.number}`;
  const question = line(row.prompt) || `Please send: ${line(row.label) || "the missing detail"}`;
  switch (row.kind) {
    case "ask":
    case "reminder":
      return `We need one more detail for ${request}.\n\n${question}\n\nReply to this message with your answer.`;
    case "assigned":
      return `Your ${request} is assigned to ${line(row.assignee_name) || "a member of the legal team"}.`;
    case "done":
      return `Your ${request} has been completed.`;
    case "reply":
      return `${line(row.author_name) || "The legal team"} replied on ${request}:\n\n${row.body ?? ""}`;
    case "no_response":
      return `We haven't heard back, so ${request} has been closed. Send a new message if you still need help.`;
    case "merged":
      return `Your ${request} has been combined with another that the legal team is following.`;
  }
}

export function intakeEmail(row: MailRow): EmailMessage {
  const domain = row.address.slice(row.address.lastIndexOf("@") + 1);
  return {
    to: { email: row.email, name: "" },
    subject: `[Request #${row.number}] ${SUBJECTS[row.kind]}`,
    text: text(row),
    replyTo: row.address,
    messageId: `<lli.${row.token}@${domain}>`,
    // A lawyer's reply is a person writing; the rest is not.
    auto: row.kind !== "reply",
  };
}

/**
 * Sends what is queued. A crash between sending and recording sends the same message again,
 * with the same Message-ID.
 */
export async function sendIntakeMail(
  pool: pg.Pool,
  mail: IntakeMail,
  only: string[],
  log: (line: string) => void,
): Promise<void> {
  const query = <T extends pg.QueryResultRow>(sql: string, params: unknown[]) =>
    asWorker(pool, async (db) => (await db.query<T>(sql, params)).rows);
  for (let n = 0; n < BATCH; n++) {
    const [row] = await query<MailRow>("select * from apps.claim_intake_mail($1, $2, $3)", [
      300,
      mail.perHour ?? 20,
      only.length > 0 ? only : null,
    ]);
    if (!row) return;
    let status = "sent";
    try {
      await mail.provider.send(intakeEmail(row));
    } catch (err) {
      // The error's name only: a mail server's text can quote the address and the message.
      log(`intake mail ${row.id} not sent: ${(err as Error).name}`);
      status = row.attempt >= MAX_ATTEMPTS ? "failed" : "queued";
    }
    await query("select apps.end_intake_mail($1, $2, $3, $4)", [
      row.id,
      row.lease,
      status,
      Math.min(60 * 2 ** (row.attempt - 1), 21_600),
    ]);
  }
}
