import { Worker } from "node:worker_threads";

export type Isolated<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" | "memory" | "crashed" };

export interface IsolateOptions {
  timeoutMs: number;
  maxMemoryMb: number;
  /** How far the whole process may grow. The heap limit can't see typed arrays. */
  maxGrowthMb: number;
}

const WATCH_MS = 50;
const MEGABYTE = 1024 * 1024;

/** A worker can be killed mid-loop, which a promise in this thread cannot. */
export function runIsolated<T>(
  url: URL,
  input: unknown,
  { timeoutMs, maxMemoryMb, maxGrowthMb }: IsolateOptions,
): Promise<Isolated<T>> {
  return new Promise((resolve) => {
    const worker = new Worker(url, {
      workerData: input,
      // Not a sandbox: it only keeps the server's settings out of process.env.
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb },
    });
    const finish = (result: Isolated<T>) => {
      clearTimeout(timer);
      clearInterval(watch);
      resolve(result);
      void worker.terminate();
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    const baseline = process.memoryUsage.rss();
    const watch = setInterval(() => {
      if (process.memoryUsage.rss() - baseline > maxGrowthMb * MEGABYTE) {
        finish({ ok: false, reason: "memory" });
      }
    }, WATCH_MS);
    worker.once("message", (value: T) => finish({ ok: true, value }));
    worker.once("error", (err: NodeJS.ErrnoException) =>
      finish({ ok: false, reason: err.code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "crashed" }),
    );
    worker.once("exit", () => finish({ ok: false, reason: "crashed" }));
  });
}
