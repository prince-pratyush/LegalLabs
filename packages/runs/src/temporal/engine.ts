import type { RunSignal } from "@legallabs/contracts";
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { RunRef } from "../activities.js";
import { engineId, type RunEngine } from "../engine.js";
import type { LifecycleResult } from "../lifecycle.js";

export const TASK_QUEUE = "legallabs-runs";

export interface TemporalOptions {
  address: string;
  namespace?: string;
  taskQueue?: string;
}

export async function connectClient(options: TemporalOptions): Promise<Client> {
  const connection = await Connection.connect({ address: options.address });
  return new Client({ connection, namespace: options.namespace ?? "default" });
}

/** The API's side: starts `run:{id}` and sends it signals. State lives in Temporal, not here. */
export function createTemporalEngine(client: Client, taskQueue = TASK_QUEUE): RunEngine {
  const handle = (runId: string) => client.workflow.getHandle(engineId(runId));
  return {
    async start(ref: RunRef) {
      try {
        await client.workflow.start("agentRun", {
          workflowId: engineId(ref.runId),
          taskQueue,
          args: [ref],
        });
      } catch (err) {
        // The same run started twice is the same run.
        if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
      }
    },
    async signal(runId: string, signal: RunSignal) {
      await handle(runId).signal(signal.name, signal);
    },
    result: (runId: string) => handle(runId).result() as Promise<LifecycleResult>,
  };
}
