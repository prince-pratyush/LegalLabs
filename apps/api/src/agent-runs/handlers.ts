import type { Gateway } from "@legallabs/model-gateway";
import type { HandlerRegistry } from "@legallabs/runs";
import { createWorkflowHandler } from "@legallabs/workflows";
import type pg from "pg";
import type { Agents } from "../agents/agents.js";
import { createBuilderHandler } from "../agents/builder.js";
import { createContextPort } from "../agents/context.js";
import { createAgentHandler } from "../agents/run-handler.js";
import type { ToolExecutor } from "../connectors/executor.js";
import type { Documents } from "../documents/documents.js";
import { type WorkflowPortOptions, workflowPorts } from "../workflows/ports.js";

export interface HandlerDeps {
  gateway?: Gateway;
  agents?: Agents;
  documents?: Documents;
  /** Runs an agent's connector tool calls; left out, agents are offered no tools. */
  tools?: ToolExecutor;
  /** What one agent run may spend. */
  maxCostUsd?: number;
  /** Ports other modules supply to workflow runs; any left out fails its step with NOT_CONNECTED. */
  workflowPorts?: WorkflowPortOptions["ports"];
}

/** The handler for each kind of run, shared by the API (local engine) and the worker. */
export function runHandlers(pool: pg.Pool, deps: HandlerDeps): HandlerRegistry {
  const { gateway, agents } = deps;
  const agent =
    gateway && agents
      ? createAgentHandler({
          pool,
          gateway,
          context: createContextPort(pool),
          ...(deps.tools ? { tools: deps.tools } : {}),
          ...(deps.maxCostUsd ? { maxCostUsd: deps.maxCostUsd } : {}),
        })
      : undefined;
  return {
    // Agent runs need a model and the agents module; a harness that only runs workflows omits both.
    ...(gateway && agents && agent
      ? {
          agent,
          // The assistant on a Space task: the same loop, with no saved agent and no tools.
          assistant: agent,
          agent_builder: createBuilderHandler({ pool, gateway, agents }),
        }
      : {}),
    workflow: createWorkflowHandler(
      workflowPorts(pool, {
        ...(gateway ? { gateway } : {}),
        ...(deps.documents ? { documents: deps.documents } : {}),
        ...(deps.workflowPorts ? { ports: deps.workflowPorts } : {}),
      }),
    ),
  };
}
