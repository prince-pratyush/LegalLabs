import type pg from "pg";
import { asWorker } from "../db.js";

const NO_MAIL =
  "mail is not configured (set LEGALLABS_SMTP_HOST and LEGALLABS_MAIL_FROM): guests cannot be " +
  "invited or sent sign-in codes, and notification emails are written to the log, not sent";

/** Whether anyone outside the workspace can, or could on accepting an invite, sign in by code. */
export async function guestsInUse(pool: pg.Pool): Promise<boolean> {
  return asWorker(pool, async (db) => {
    const { rows } = await db.query<{ used: boolean }>("select admin.guests_in_use() as used");
    return rows[0]?.used === true;
  });
}

/**
 * What start-up should do about mail. A guest's only way in is an emailed code, so a production
 * deployment that has guests and no mail server stops rather than leave them locked out.
 */
export function mailStartupCheck(
  env: NodeJS.ProcessEnv,
  state: { configured: boolean; guests: boolean },
): { action: "ok" | "warn" | "refuse"; message: string } {
  if (state.configured) return { action: "ok", message: "" };
  if (env.NODE_ENV === "production" && state.guests) {
    return { action: "refuse", message: `${NO_MAIL}. This database has guests or open invites.` };
  }
  return { action: "warn", message: `warning: ${NO_MAIL}.` };
}
