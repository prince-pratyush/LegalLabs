import { NUDGE_SUPPRESS_DAYS } from "@legallabs/contracts";
import type pg from "pg";
import type { Principal } from "../auth/auth.js";
import { asApp } from "../db.js";

export interface Nudge {
  agent_id: string;
  title: string;
}

/** Below this rank a match is too thin to interrupt someone for. */
const MIN_RANK = 0.05;

export interface Nudges {
  /** At most one shared agent the person can run that fits what they typed; nothing runs. */
  match(principal: Principal, prompt: string): Promise<Nudge | null>;
  /** Quiet for that agent for 30 days. */
  dismiss(principal: Principal, agentId: string): Promise<void>;
}

export function createNudges(pool: pg.Pool): Nudges {
  return {
    match(principal, prompt) {
      const text = prompt.trim().slice(0, 1000);
      if (text.length < 3) return Promise.resolve(null);
      return asApp(pool, principal, async (db) => {
        // Any word of the prompt may match; the function ORs its lexemes.
        const { rows } = await db.query<{ id: string; title: string; rank: number }>(
          "select id, title, rank from work.agent_nudge($1, $2)",
          [text, NUDGE_SUPPRESS_DAYS],
        );
        const best = rows[0];
        return best && best.rank >= MIN_RANK ? { agent_id: best.id, title: best.title } : null;
      });
    },

    dismiss(principal, agentId) {
      return asApp(pool, principal, async (db) => {
        await db.query(
          `insert into work.agent_nudge_dismissal (workspace_id, user_id, agent_id)
           select $1, $2, a.id from work.agent a where a.id = $3
           on conflict (user_id, agent_id) do update set dismissed_at = now()`,
          [principal.workspaceId, principal.userId, agentId],
        );
      });
    },
  };
}
