import type { HandlerRegistry } from "@legallabs/runs";
import { createWorkflowHandler } from "@legallabs/workflows";
import type pg from "pg";
import { type WorkflowPortOptions, workflowPorts } from "../workflows/ports.js";

/**
 * The handler for each kind of run, shared by the API (local engine) and the worker. Ports a
 * module hasn't supplied fail their step with NOT_CONNECTED rather than guess.
 */
export function runHandlers(pool: pg.Pool, options: WorkflowPortOptions = {}): HandlerRegistry {
  return {
    workflow: createWorkflowHandler(workflowPorts(pool, options)),
  };
}
