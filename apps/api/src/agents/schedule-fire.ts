import { firesOn, nextScheduledRun, type Schedule } from "@legallabs/contracts";
import type pg from "pg";
import type { AgentRuns } from "../agent-runs/runs.js";
import { asApp, asWorker } from "../db.js";
import type { Agents } from "./agents.js";
import type { SchedulePort } from "./ports.js";

interface FireRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  user_id: string;
  rule: Schedule["rule"];
  params: Schedule["params"];
  time_local: string;
  tz: string;
  matter_id: string | null;
  email: boolean;
  anchor_date: Date | null;
  status: string;
  live_version_id: string | null;
}

export type FireOutcome = "started" | "skipped_day" | "inactive" | "paused" | "missing";

/** The date in the schedule's own zone, since "Monday" means Monday where the person is. */
function civil(tz: string, at: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

/**
 * What a Temporal Schedule's fire does: re-checks the person's access and walls, then starts a
 * non-interactive run as them. Losing Run access pauses the schedule instead (§3.6).
 */
export function createScheduleFirer(options: {
  pool: pg.Pool;
  agents: Agents;
  runs: AgentRuns;
  scheduler?: SchedulePort | undefined;
}) {
  const { pool, agents, runs } = options;

  return async function fire(scheduleId: string, firedAt: string): Promise<FireOutcome> {
    const row = await asWorker(pool, async (db) => {
      const { rows } = await db.query<FireRow>("select * from work.agent_schedule_for_fire($1)", [
        scheduleId,
      ]);
      return rows[0] ?? null;
    });
    if (!row) return "missing";
    if (row.status !== "active" || !row.live_version_id) return "inactive";

    const schedule: Schedule = {
      rule: row.rule,
      params: row.params,
      time_local: row.time_local,
      tz: row.tz,
      email: row.email,
      ...(row.anchor_date ? { anchor_date: row.anchor_date.toISOString().slice(0, 10) } : {}),
    };
    const at = new Date(firedAt);
    const day = civil(row.tz, at);
    if (!firesOn(schedule, day.y, day.m, day.d)) return "skipped_day";

    const principal = { sessionId: "schedule", userId: row.user_id, workspaceId: row.workspace_id };
    const pause = async (reason: string) => {
      await asWorker(pool, (db) =>
        db.query("select work.agent_schedule_pause($1, $2)", [scheduleId, reason]),
      );
      await asApp(pool, principal, (db) =>
        db.query(
          "select admin.append_audit_event('agent.schedule.paused', 'user', $1, 'agent', $2, $3, null, null)",
          [row.user_id, row.agent_id, JSON.stringify({ reason })],
        ),
      );
      await options.scheduler?.pause(scheduleId, reason).catch(() => {});
      return "paused" as const;
    };

    // Run access and the matter's wall are checked at every fire, not just when scheduled.
    const found = await agents.get(principal, row.agent_id);
    if (!found) return pause("access_lost");
    if (row.matter_id) {
      const matter = await asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ ok: boolean }>("select core.can_access_matter($1) ok", [
          row.matter_id,
        ]);
        return rows[0]?.ok ?? false;
      });
      if (!matter) return pause("wall_changed");
    }

    await runs.start(principal, {
      kind: "agent",
      subject_id: row.agent_id,
      agent_version_id: row.live_version_id,
      title: found.agent.title,
      ...(row.params.inputs ? { inputs: row.params.inputs } : {}),
      ...(row.matter_id ? { matter_id: row.matter_id } : {}),
      path: "schedule",
      interactive: false,
    });
    const next = nextScheduledRun(schedule, at);
    await asApp(pool, principal, (db) =>
      db.query(
        "update work.agent_schedule set next_run_at = $2, updated_at = now() where id = $1",
        [scheduleId, next?.toISOString() ?? null],
      ),
    );
    return "started";
  };
}
