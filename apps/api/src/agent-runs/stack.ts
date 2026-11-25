import type { Gateway } from "@legallabs/model-gateway";
import type { RunRef } from "@legallabs/runs";
import type pg from "pg";
import type { AdminConnectors } from "../admin-models/connectors.js";
import type { Agents } from "../agents/agents.js";
import { createToolExecutor } from "../connectors/executor.js";
import { asApp } from "../db.js";
import type { Documents } from "../documents/documents.js";
import { createTaskRuns } from "../spaces/agent-runs.js";
import type { SpaceModule } from "../spaces/module.js";
import { runEngineFromEnv } from "./engine.js";
import { runHandlers } from "./handlers.js";
import { createAgentRunPort } from "./port.js";
import { createAgentRuns } from "./runs.js";

export interface RunStackDeps {
  gateway: Gateway;
  documents: Documents;
  agents: Agents;
  connectors: AdminConnectors;
  env?: NodeJS.ProcessEnv;
}

/** What one agent or assistant run may spend on models, unless the install says otherwise. */
export function agentRunBudget(env: NodeJS.ProcessEnv): number {
  const set = Number(env.LEGALLABS_AGENT_MAX_COST_USD);
  return set > 0 ? set : 5;
}

/** The handlers every process that does runs needs, with connector tools behind the policy. */
export function agentRunHandlers(pool: pg.Pool, deps: RunStackDeps) {
  return runHandlers(pool, {
    gateway: deps.gateway,
    agents: deps.agents,
    documents: deps.documents,
    tools: createToolExecutor(pool, { connectors: deps.connectors }),
    maxCostUsd: agentRunBudget(deps.env ?? process.env),
  });
}

/** How the API server runs agents, workflows and Space tasks. */
export async function createRunStack(pool: pg.Pool, deps: RunStackDeps) {
  const env = deps.env ?? process.env;
  let spaces: SpaceModule | undefined;

  /** Hands a finished run's task back at once; without this it settles when next read. */
  const settle = async (ref: RunRef) => {
    const who = { userId: ref.userId, workspaceId: ref.workspaceId };
    const taskId = await asApp(pool, who, async (db) => {
      const { rows } = await db.query<{ task_id: string | null }>(
        "select task_id from work.run where id = $1",
        [ref.runId],
      );
      return rows[0]?.task_id;
    });
    if (taskId) await spaces?.tasks.runFinished(who, ref.runId, { ip: null, userAgent: null });
  };

  const engine = await runEngineFromEnv(pool, agentRunHandlers(pool, deps), env, settle);
  const agentRuns = createAgentRuns(pool, { engine, maxCostUsd: agentRunBudget(env) });
  const port = createAgentRunPort(pool, { agents: deps.agents, runs: agentRuns });

  return {
    engine,
    agentRuns,
    port,
    taskRuns: createTaskRuns(pool, { port, runs: agentRuns }),
    /** Tells the stack which Spaces module to hand finished task runs back to. */
    attach(module: SpaceModule): SpaceModule {
      spaces = module;
      return module;
    },
  };
}
