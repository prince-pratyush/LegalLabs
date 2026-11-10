import { Worker } from "node:worker_threads";

export type Isolated<T> = { ok: true; value: T } | { ok: false; reason: "timeout" | "crashed" };

export interface IsolateOptions {
  timeoutMs: number;
  maxMemoryMb: number;
}

/** A worker can be killed mid-loop, which a promise in this thread cannot. */
export function runIsolated<T>(
  url: URL,
  input: unknown,
  { timeoutMs, maxMemoryMb }: IsolateOptions,
): Promise<Isolated<T>> {
  return new Promise((resolve) => {
    const worker = new Worker(url, {
      workerData: input,
      // Empty, so code smuggled in a file can't read the database password.
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb },
    });
    const finish = (result: Isolated<T>) => {
      clearTimeout(timer);
      resolve(result);
      void worker.terminate();
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    worker.once("message", (value: T) => finish({ ok: true, value }));
    worker.once("error", () => finish({ ok: false, reason: "crashed" }));
    worker.once("exit", () => finish({ ok: false, reason: "crashed" }));
  });
}
