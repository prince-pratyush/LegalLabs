import { createLocalEngine, type HandlerRegistry, type RunEngine } from "@legallabs/runs";
import { connectClient, createTemporalEngine } from "@legallabs/runs/temporal";
import type pg from "pg";
import { runAudit } from "./audit.js";

/**
 * Temporal when the install has one (`TEMPORAL_ADDRESS`), so runs outlive a restart; otherwise
 * a run lives in this process, which the dev-lite profile accepts.
 */
export async function runEngineFromEnv(
  pool: pg.Pool,
  handlers: HandlerRegistry,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunEngine> {
  const address = env.TEMPORAL_ADDRESS;
  if (address) {
    const client = await connectClient({
      address,
      ...(env.TEMPORAL_NAMESPACE ? { namespace: env.TEMPORAL_NAMESPACE } : {}),
    });
    return createTemporalEngine(client);
  }
  return createLocalEngine({ pool, handlers, audit: runAudit(pool) });
}
