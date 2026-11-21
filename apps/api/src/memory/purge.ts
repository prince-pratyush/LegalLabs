import type { Memories } from "./memory.js";

export interface PurgeJob {
  start(): void;
  stop(): Promise<void>;
}

/** Hourly: drops candidates 30 days after they were made, and uploads left unreviewed. */
export function createMemoryPurgeJob(
  memories: Pick<Memories, "purge">,
  options: { intervalMs?: number; log?: (line: string) => void } = {},
): PurgeJob {
  const interval = options.intervalMs ?? 60 * 60 * 1000;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;

  const tick = () => {
    running = memories
      .purge()
      .then(({ candidates, imports }) => {
        if (candidates || imports) {
          options.log?.(`memory: ${candidates} candidates and ${imports} uploads dropped`);
        }
      })
      .catch((err: unknown) =>
        options.log?.(`memory purge failed: ${err instanceof Error ? err.name : "unknown"}`),
      )
      .finally(() => {
        running = null;
      });
  };

  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(() => {
        if (!running) tick();
      }, interval);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
