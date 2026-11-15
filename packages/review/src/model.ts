import type { CompleteResult, PhaseUsage, ReviewDeps, Task } from "./types.js";

/** Replies past this are cut before parsing; no valid answer here is anywhere near it. */
export const MAX_REPLY_CHARS = 64_000;

export class CallTimeout extends Error {
  constructor() {
    super("model call ran out of time");
  }
}

export const emptyUsage = (): PhaseUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
  models: [],
  calls: 0,
});

export function addUsage(into: PhaseUsage, from: PhaseUsage) {
  into.input_tokens += from.input_tokens;
  into.output_tokens += from.output_tokens;
  into.cost_usd += from.cost_usd;
  into.calls += from.calls;
  for (const m of from.models) if (!into.models.includes(m)) into.models.push(m);
}

const asUsage = (r: CompleteResult): PhaseUsage => ({
  input_tokens: r.usage.input_tokens,
  output_tokens: r.usage.output_tokens,
  cost_usd: r.cost_usd,
  models: [r.model],
  calls: 1,
});

export function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < n) active++;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      return await fn();
    } finally {
      // Hand the slot straight to a waiter so a newcomer can't slip past the cap.
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

/** Time a rule may spend inside model calls; queueing for a slot does not count. */
export type Budget = { limitMs: number; spentMs: number };

export type CallRequest = { task: Task; system: string; prompt: string; maxTokens: number };
export type Call = (
  req: CallRequest,
  opts: { usage: PhaseUsage; budget?: Budget },
) => Promise<{ text: string; model: string }>;

/**
 * Wraps deps.complete: at most `parallelism` calls run at once, the run's signal aborts
 * them, and a budget's clock starts only once the call has its slot.
 */
export function makeCaller(
  complete: ReviewDeps["complete"],
  parallelism: number,
  signal: AbortSignal | undefined,
  now: () => number = () => performance.now(),
): Call {
  const limit = limiter(parallelism);
  return (req, { usage, budget }) =>
    limit(async () => {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const left = budget ? budget.limitMs - budget.spentMs : Number.POSITIVE_INFINITY;
      if (left <= 0) throw new CallTimeout();
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort(signal?.reason ?? new Error("aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = Number.isFinite(left)
        ? setTimeout(() => ctrl.abort(new CallTimeout()), left)
        : undefined;
      const started = now();
      try {
        const res = await raceAbort(
          complete({ ...req, json: true, signal: ctrl.signal }),
          ctrl.signal,
        );
        addUsage(usage, asUsage(res));
        return { text: res.text.slice(0, MAX_REPLY_CHARS), model: res.model };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (budget) budget.spentMs += now() - started;
      }
    });
}

// The provider may ignore the signal; the caller must not hang on it.
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
