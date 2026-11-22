import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { ActivityDeps } from "../activities.js";
import { createTemporalActivities, type ScheduleFirer } from "./activities.js";
import { TASK_QUEUE, type TemporalOptions } from "./engine.js";

export interface WorkerOptions extends TemporalOptions {
  deps: ActivityDeps;
  fire?: ScheduleFirer;
  /** The compiled workflows file; tests point at the source instead. */
  workflowsPath?: string;
}

/** The process that does a run's work. Restarting it loses nothing: Temporal replays the run. */
export async function createRunWorker(options: WorkerOptions): Promise<Worker> {
  const connection = await NativeConnection.connect({ address: options.address });
  return Worker.create({
    connection,
    namespace: options.namespace ?? "default",
    taskQueue: options.taskQueue ?? TASK_QUEUE,
    workflowsPath:
      options.workflowsPath ?? fileURLToPath(new URL("./workflows.js", import.meta.url)),
    activities: createTemporalActivities(options.deps, options.fire),
  });
}
