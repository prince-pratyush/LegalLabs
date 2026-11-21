import type pg from "pg";
import { asWorker } from "../db.js";
import type { EmailMessage, EmailProvider } from "./email-port.js";

export interface EmailWorker {
  /** One pass: sends what is due. Returns the number of emails sent and failed. */
  runOnce(now?: Date): Promise<{ sent: number; failed: number }>;
  start(): void;
  stop(): Promise<void>;
}

interface Claimed {
  id: string;
  batch_key: string;
  to_email: string;
  to_name: string;
  payload: {
    subject: string;
    text: string;
    url: string;
    actor?: string;
    excerpt?: string;
  };
}

/** Links point at the web app, whose routes live after the `#`. */
export const linkTo = (baseUrl: string, url: string) =>
  `${baseUrl.replace(/\/+$/, "")}/${url.startsWith("/") ? url.slice(1) : url}`;

const lines = (c: Claimed, baseUrl: string): string[] => [
  c.payload.text,
  ...(c.payload.actor ? [`By ${c.payload.actor}`] : []),
  ...(c.payload.excerpt ? [`"${c.payload.excerpt}"`] : []),
  linkTo(baseUrl, c.payload.url),
];

/** One email per batch: a single item as is, several as a short digest. */
export function render(items: Claimed[], baseUrl: string): EmailMessage {
  const first = items[0] as Claimed;
  const to = { email: first.to_email, name: first.to_name };
  if (items.length === 1) {
    return { to, subject: first.payload.subject, text: lines(first, baseUrl).join("\n") };
  }
  return {
    to,
    subject: `${items.length} updates in LegalLabs`,
    text: items.map((c) => `- ${lines(c, baseUrl).join("\n  ")}`).join("\n\n"),
  };
}

/**
 * Sends the outbox. Runs as the worker role through definer functions, so it never holds a
 * person's identity: it claims due rows, sends one email per batch, then marks the rows.
 */
export function createEmailWorker(
  pool: pg.Pool,
  options: {
    provider: EmailProvider;
    baseUrl: string;
    intervalMs?: number;
    log?: (line: string) => void;
  },
): EmailWorker {
  const interval = options.intervalMs ?? 60 * 1000;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;

  async function runOnce(now: Date = new Date()) {
    const claimed = await asWorker(pool, async (db) => {
      const { rows } = await db.query<Claimed>("select * from notify.claim_email($1, 200)", [
        now.toISOString(),
      ]);
      return rows;
    });
    const batches = new Map<string, Claimed[]>();
    for (const row of claimed)
      batches.set(row.batch_key, [...(batches.get(row.batch_key) ?? []), row]);
    let sent = 0;
    let failed = 0;
    for (const items of batches.values()) {
      const ids = items.map((i) => i.id);
      try {
        await options.provider.send(render(items, options.baseUrl));
        await asWorker(pool, (db) =>
          db.query("select notify.mark_email_sent($1::uuid[], $2)", [ids, now.toISOString()]),
        );
        sent += 1;
      } catch (err) {
        failed += 1;
        const reason = err instanceof Error ? err.name : "unknown";
        await asWorker(pool, (db) =>
          db.query("select notify.mark_email_error($1::uuid[], $2, $3)", [
            ids,
            `send failed: ${reason}`,
            now.toISOString(),
          ]),
        ).catch(() => undefined);
      }
    }
    return { sent, failed };
  }

  const tick = () => {
    running = runOnce()
      .then(({ sent, failed }) => {
        if (sent || failed) options.log?.(`email: ${sent} sent, ${failed} failed`);
      })
      .catch((err: unknown) =>
        options.log?.(`email worker failed: ${err instanceof Error ? err.name : "unknown"}`),
      )
      .finally(() => {
        running = null;
      });
  };

  return {
    runOnce,
    start() {
      if (timer) return;
      tick();
      timer = setInterval(() => {
        if (!running) tick();
      }, interval);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
