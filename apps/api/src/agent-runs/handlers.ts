import type { HandlerRegistry } from "@legallabs/runs";
import type pg from "pg";

/** The handler for each kind of run, shared by the API (local engine) and the worker. */
export function runHandlers(_pool: pg.Pool): HandlerRegistry {
  return {};
}
