import type { Notifications } from "./notifications.js";

export interface PurgeJob {
  start(): void;
  stop(): Promise<void>;
}

/** Hourly housekeeping: archives long-unavailable items and deletes old ones. */
export function createPurgeJob(
  notifications: Pick<Notifications, "purge">,
  options: { intervalMs?: number; log?: (line: string) => void } = {},
): PurgeJob {
  const interval = options.intervalMs ?? 60 * 60 * 1000;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;

  const tick = () => {
    running = notifications
      .purge()
      .then(({ archived, deleted }) => {
        if (archived || deleted) {
          options.log?.(`notifications: ${archived} archived, ${deleted} deleted`);
        }
      })
      .catch((err: unknown) =>
        options.log?.(`notification purge failed: ${err instanceof Error ? err.name : "unknown"}`),
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
