import type pg from "pg";
import type { SecretBox } from "../admin-models/secrets.js";
import { asWorker } from "../db.js";
import { intakeText, type MailRow } from "./mail.js";
import type { SlackApi } from "./slack-api.js";

// Messages to a Slack requester, from the same queue and with the same fixed words as mail:
// nothing a requester or a model wrote is ever posted, and there is no link. Each goes under
// the request's thread, or, to start one after a slash command, to the requester alone.

export interface IntakeSlack {
  api: SlackApi;
  secrets: SecretBox;
  /** The system's own messages to one person in a day; replies from lawyers aren't counted. */
  perDay?: number;
  /** New requests from one person that the system answers in a day. */
  requestsPerDay?: number;
}

interface Row extends Omit<MailRow, "token" | "email" | "address"> {
  slack_user: string;
  slack_channel: string | null;
  thread_ts: string | null;
  bot_token_sealed: Buffer;
}

const MAX_ATTEMPTS = 5;
const BATCH = 25;

export const slackMessage = (row: Pick<Row, keyof Parameters<typeof intakeText>[0]>) =>
  row.kind === "ack" ? `Got it — request #${row.number}.` : intakeText(row, "slack");

/**
 * Posts what is queued. A crash between posting and recording posts the same message again:
 * Slack offers nothing to tell them apart by.
 */
export async function sendIntakeSlack(
  pool: pg.Pool,
  slack: IntakeSlack,
  only: string[],
  log: (line: string) => void,
): Promise<void> {
  const query = <T extends pg.QueryResultRow>(sql: string, params: unknown[]) =>
    asWorker(pool, async (db) => (await db.query<T>(sql, params)).rows);
  for (let n = 0; n < BATCH; n++) {
    const [row] = await query<Row>("select * from apps.claim_slack_post($1, $2, $3, $4)", [
      300,
      slack.perDay ?? 30,
      slack.requestsPerDay ?? 10,
      only.length > 0 ? only : null,
    ]);
    if (!row) return;
    let retry = Math.min(60 * 2 ** (row.attempt - 1), 21_600);
    try {
      const posted = await slack.api.post(slack.secrets.open(row.bot_token_sealed), {
        channel: row.slack_channel ?? row.slack_user,
        threadTs: row.thread_ts,
        text: slackMessage(row),
      });
      if (posted.ok) {
        await query("select apps.sent_slack_post($1, $2, $3, $4)", [
          row.id,
          row.lease,
          posted.channel,
          posted.ts,
        ]);
        continue;
      }
      log(`intake slack ${row.id} not sent: ${posted.error}`);
      retry = posted.retryAfter ?? retry;
    } catch (err) {
      // The error's name only: its text could quote the request that was made.
      log(`intake slack ${row.id} not sent: ${(err as Error).name}`);
    }
    await query("select apps.end_intake_mail($1, $2, $3, $4)", [
      row.id,
      row.lease,
      row.attempt >= MAX_ATTEMPTS ? "failed" : "queued",
      retry,
    ]);
  }
}
