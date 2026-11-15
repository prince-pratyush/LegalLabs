import { isTerminal, type RunStatus } from "@legallabs/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { streamRun } from "../api.js";
import { type LiveRun, reduceRun, startRun } from "./run-state.js";

const RETRIES = 3;
const BACKOFF_MS = 1000;

export interface KnownRun {
  id: string;
  status: RunStatus;
  plan: unknown;
}

/**
 * Follows one run's events. A dropped stream (network, 404, too many open
 * streams) is reopened after the last event seen, with growing waits; after a
 * few failures it stops and says so, rather than leaving Stop up forever.
 * A plan awaiting approval holds no connection until `resume` is called.
 */
export function useRunStream(run: KnownRun | null, onFinished: (runId: string) => void) {
  const [live, setLive] = useState<LiveRun | null>(null);
  const [held, setHeld] = useState(false);
  const [lost, setLost] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const failures = useRef(0);
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  });

  const runId = run?.id ?? null;

  // A new run starts from what the thread already says about it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new run id starts over
  useEffect(() => {
    if (!run) return;
    setLive(startRun(run.id, { status: run.status, plan: run.plan }));
    seq.current = 0;
    failures.current = 0;
    setHeld(false);
    setLost(false);
  }, [runId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt reopens the stream
  useEffect(() => {
    if (!runId || held || lost) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    const close = streamRun(
      runId,
      (event) => {
        seq.current = event.seq;
        failures.current = 0;
        setLive((current) => (current?.runId === runId ? reduceRun(current, event) : current));
        if (isTerminal(event)) {
          ended = true;
          close();
          finished.current(runId);
        } else if (event.type === "status" && event.status === "awaiting_approval") {
          // Nothing more comes until a person decides, so the connection is let go.
          close();
          setHeld(true);
        }
      },
      {
        after: seq.current,
        onDrop: () => {
          if (ended) return;
          failures.current += 1;
          if (failures.current > RETRIES) {
            setLost(true);
            return;
          }
          retry = setTimeout(
            () => setAttempt((n) => n + 1),
            BACKOFF_MS * 2 ** (failures.current - 1),
          );
        },
      },
    );
    return () => {
      clearTimeout(retry);
      close();
    };
  }, [runId, held, lost, attempt]);

  /** Reopens after a plan was approved or edited. */
  const resume = useCallback(() => setHeld(false), []);

  /** The "Reconnect" button after the stream was given up on. */
  const reconnect = useCallback(() => {
    failures.current = 0;
    setLost(false);
    setAttempt((n) => n + 1);
  }, []);

  return { live, setLive, lost, resume, reconnect };
}
