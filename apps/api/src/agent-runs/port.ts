import { AgentRunError, type AgentRunPort, type Caller } from "@legallabs/contracts";
import type pg from "pg";
import type { Agents } from "../agents/agents.js";
import type { Principal } from "../auth/auth.js";
import { asApp, RLS_REFUSED } from "../db.js";
import type { AgentRuns } from "./runs.js";

/** The longest input a run takes here: a task's text with its Space Context in front. */
export const MAX_INPUT_CHARS = 20_000;
const NO_CLIENT = { ip: null, userAgent: null };

const principalOf = (caller: Caller): Principal => ({ sessionId: "port", ...caller });

/**
 * `AgentRunPort` over the real run engine: the same checks as a run from the Agents page (the
 * caller's access to the agent, its live version, their walls), then a run that calls the
 * model through the gateway. Everything is read and written as the caller.
 */
export function createAgentRunPort(
  pool: pg.Pool,
  deps: { agents: Agents; runs: AgentRuns },
): AgentRunPort {
  const { agents, runs } = deps;

  return {
    async start(caller, request) {
      const p = principalOf(caller);
      const found = await agents.get(p, request.agent_id);
      if (!found) throw new AgentRunError("NOT_FOUND");
      const version = request.version_id ?? found.agent.live_version_id;
      if (!version) throw new AgentRunError("NOT_LIVE");
      if (request.version_id && found.agent.my_access === "run") {
        throw new AgentRunError("FORBIDDEN");
      }
      if ((request.inputs?.length ?? 0) > MAX_INPUT_CHARS) {
        throw new AgentRunError("INPUT_INVALID");
      }
      const matterId = await asApp(pool, p, async (db) => {
        let matter = request.matter_id ?? null;
        if (request.space_id) {
          const space = (
            await db.query<{ matter_id: string | null }>(
              "select matter_id from work.space where id = $1",
              [request.space_id],
            )
          ).rows[0];
          if (!space) throw new AgentRunError("NOT_FOUND");
          // Work in a Space belongs to the Space's matter, whatever the request left out.
          matter ??= space.matter_id;
        }
        if (matter) {
          const open = (
            await db.query<{ ok: boolean }>("select core.can_access_matter($1) ok", [matter])
          ).rows[0]?.ok;
          if (!open) throw new AgentRunError("WALL_DENIED");
        }
        return matter;
      });
      try {
        return await runs.start(p, {
          kind: "agent",
          subject_id: found.agent.id,
          agent_version_id: version,
          title: found.agent.title,
          path: request.path,
          ...(request.inputs ? { inputs: request.inputs } : {}),
          ...(matterId ? { matter_id: matterId } : {}),
          ...(request.space_id ? { space_id: request.space_id } : {}),
          ...(request.thread_id ? { thread_id: request.thread_id } : {}),
          ...(request.task_id ? { task_id: request.task_id } : {}),
          ...(request.interactive === undefined ? {} : { interactive: request.interactive }),
          ...(request.test_mode === undefined ? {} : { test_mode: request.test_mode }),
        });
      } catch (err) {
        if ((err as { code?: string }).code === RLS_REFUSED) throw new AgentRunError("FORBIDDEN");
        throw err;
      }
    },

    get: (caller, runId) => runs.get(principalOf(caller), runId),

    async signal(caller, runId, signal) {
      const result = await runs.signal(principalOf(caller), runId, signal, NO_CLIENT);
      // A finished run has nothing left to hear, so cancelling it again is not an error.
      if (result === "NOT_FOUND" || result === "FORBIDDEN") throw new AgentRunError(result);
    },
  };
}
