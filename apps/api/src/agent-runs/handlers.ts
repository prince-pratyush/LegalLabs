import type { Gateway } from "@legallabs/model-gateway";
import type { HandlerRegistry } from "@legallabs/runs";
import type pg from "pg";
import type { Agents } from "../agents/agents.js";
import { createBuilderHandler } from "../agents/builder.js";
import { createContextPort } from "../agents/context.js";
import { createAgentHandler } from "../agents/run-handler.js";

export interface HandlerDeps {
  gateway: Gateway;
  agents: Agents;
}

/** The handler for each kind of run, shared by the API (local engine) and the worker. */
export function runHandlers(pool: pg.Pool, deps: HandlerDeps): HandlerRegistry {
  return {
    agent: createAgentHandler({ pool, gateway: deps.gateway, context: createContextPort(pool) }),
    agent_builder: createBuilderHandler({ pool, gateway: deps.gateway, agents: deps.agents }),
  };
}
