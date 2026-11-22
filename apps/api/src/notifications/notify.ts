import { isRelativeLink } from "@legallabs/contracts";
import type pg from "pg";
import type { Principal } from "../auth/auth.js";
import { asApp } from "../db.js";
import { CATALOGUE, type NotificationEvent } from "./catalogue.js";
import type { Hub } from "./hub.js";

export type { NotificationEvent, NotificationPeople } from "./catalogue.js";

/**
 * What modules hold. `notify` never throws: a failure to tell someone must not break the
 * thing they did. `principal` is the person whose request this is; the actor is named in the
 * event, so an event with no actor (a run finishing) still goes out under the runner.
 */
export interface Notifier {
  notify(principal: Principal, event: NotificationEvent): Promise<void>;
}

/** For modules built without a notifications hub (most tests). */
export const noNotifier: Notifier = { notify: async () => {} };

const BODY_CHARS = 500;

export function createNotifier(
  pool: pg.Pool,
  hub: Hub,
  log: (line: string) => void = console.error,
): Notifier {
  return {
    async notify(principal, event) {
      try {
        const entry = CATALOGUE[event.kind];
        if (!entry.in_app) return;
        const recipients = [...new Set(entry.recipients(event))].filter(
          (id) => id !== event.actorId,
        );
        if (recipients.length === 0) return;
        // A link that leaves the app is a phishing vector, so such an event is dropped, not sent.
        const link = entry.link(event);
        if (!isRelativeLink(link)) {
          log(`notify ${event.kind} dropped: link is not an in-app link`);
          return;
        }
        const body =
          entry.body && event.detail ? [...event.detail].slice(0, BODY_CHARS).join("") : null;
        const made = await asApp(pool, principal, async (db) => {
          const { rows } = await db.query<{ user_id: string; notification_id: string }>(
            `select user_id, notification_id from notify.emit($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11,
               $12::uuid[])`,
            [
              event.kind,
              entry.category,
              event.objectType,
              event.objectId,
              entry.title(event),
              body,
              event.actorId,
              entry.action_required,
              JSON.stringify(entry.actions ?? []),
              link,
              event.matterId ?? null,
              recipients,
            ],
          );
          return rows;
        });
        for (const userId of new Set(made.map((r) => r.user_id))) hub.publish(userId);
        if (entry.email) {
          // After the notification is committed, so a mail problem never undoes it. What the
          // mail says is read from the notification itself by the database.
          try {
            await asApp(pool, principal, (db) =>
              db.query("select notify.enqueue_email($1::uuid[], $2, $3)", [
                made.map((r) => r.notification_id),
                event.longRunning ?? false,
                entry.completion,
              ]),
            );
          } catch (err) {
            log(
              `notify ${event.kind} email failed: ${err instanceof Error ? err.name : "unknown"}`,
            );
          }
        }
      } catch (err) {
        // The kind and error name only: titles and comments stay out of logs.
        log(`notify ${event.kind} failed: ${err instanceof Error ? err.name : "unknown"}`);
      }
    },
  };
}
