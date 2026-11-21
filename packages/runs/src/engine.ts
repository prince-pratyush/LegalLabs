import type { RunSignal } from "@legallabs/contracts";
import { type ActivityDeps, createActivities, type RunRef } from "./activities.js";
import { type LifecycleResult, runLifecycle, type SignalQueue } from "./lifecycle.js";

/** How the API starts and signals runs. Temporal implements it for real; tests use the local one. */
export interface RunEngine {
  /** Starts the run's workflow; starting the same run twice is a no-op. */
  start(ref: RunRef): Promise<void>;
  signal(runId: string, signal: RunSignal): Promise<void>;
  /** Waits until the run ends; for tests and the CLI. */
  result(runId: string): Promise<LifecycleResult>;
}

/** The engine id Temporal and the run table share (agents-workflows.md §4.4). */
export const engineId = (runId: string) => `run:${runId}`;

export function signalQueue(): SignalQueue & { push(signal: RunSignal): void } {
  const items: RunSignal[] = [];
  let wake: (() => void) | null = null;
  return {
    push(signal) {
      items.push(signal);
      wake?.();
    },
    poll: () => items.shift(),
    wait(ms) {
      const first = items.shift();
      if (first) return Promise.resolve(first);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve("timeout");
        }, ms);
        wake = () => {
          const next = items.shift();
          if (!next) return;
          clearTimeout(timer);
          wake = null;
          resolve(next);
        };
      });
    },
  };
}

/**
 * Runs in this process, so a restart loses it: for tests and for installs without Temporal.
 * The lifecycle and activities are the same ones the Temporal worker runs.
 */
export function createLocalEngine(deps: ActivityDeps): RunEngine {
  const running = new Map<
    string,
    { queue: ReturnType<typeof signalQueue>; done: Promise<LifecycleResult> }
  >();
  return {
    async start(ref) {
      if (running.has(ref.runId)) return;
      const queue = signalQueue();
      const done = runLifecycle(
        { act: createActivities(deps, ref), signals: queue, now: Date.now },
        { kind: ref.kind, interactive: ref.interactive },
      );
      running.set(ref.runId, { queue, done });
    },
    async signal(runId, signal) {
      running.get(runId)?.queue.push(signal);
    },
    async result(runId) {
      const entry = running.get(runId);
      if (!entry) throw new Error("unknown run");
      return entry.done;
    },
  };
}
