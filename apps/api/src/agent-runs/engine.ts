import {
  createLocalEngine,
  type HandlerRegistry,
  type RunEngine,
  type RunRef,
} from "@legallabs/runs";
import {
  connectClient,
  createTemporalEngine,
  createTemporalScheduler,
} from "@legallabs/runs/temporal";
import type pg from "pg";
import type { SchedulePort } from "../agents/ports.js";
import { runAudit } from "./audit.js";

/**
 * Temporal when the install has one (`TEMPORAL_ADDRESS`), so runs outlive a restart; otherwise
 * a run lives in this process, which the dev-lite profile accepts.
 */
export async function runEngineFromEnv(
  pool: pg.Pool,
  handlers: HandlerRegistry,
  env: NodeJS.ProcessEnv = process.env,
  /** Called once a run in this process has ended; a Temporal worker's runs don't reach it. */
  onFinished?: (ref: RunRef) => Promise<void>,
): Promise<RunEngine> {
  const address = env.TEMPORAL_ADDRESS;
  if (address) {
    const client = await connectClient({
      address,
      ...(env.TEMPORAL_NAMESPACE ? { namespace: env.TEMPORAL_NAMESPACE } : {}),
    });
    return createTemporalEngine(client);
  }
  const record = runAudit(pool);
  return createLocalEngine({
    pool,
    handlers,
    async audit(ref, action, details) {
      await record(ref, action, details);
      if (action === "agent.run.finished") {
        await onFinished?.(ref).catch((err) =>
          console.error(`run ${ref.runId} could not be handed back: ${String(err)}`),
        );
      }
    },
  });
}

/** Temporal Schedules, so a schedule keeps firing while the API is down; none without Temporal. */
export async function schedulerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SchedulePort | null> {
  const address = env.TEMPORAL_ADDRESS;
  if (!address) return null;
  const client = await connectClient({
    address,
    ...(env.TEMPORAL_NAMESPACE ? { namespace: env.TEMPORAL_NAMESPACE } : {}),
  });
  return createTemporalScheduler(client);
}
