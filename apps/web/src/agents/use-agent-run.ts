import type { RunSignal } from "@legallabs/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Run } from "../api.js";
import { type KnownRun, useRunStream } from "../thread/use-run-stream.js";
import { agentApi, agentError } from "./api.js";

/**
 * Follows an agent, builder or test run and sends it signals. The stream replays from the
 * start, so a reload shows the same steps, plan or question as before.
 */
export function useAgentRun(
  runId: string | null,
  options: { onDraft?: (versionId: string) => void; onFinished?: () => void } = {},
) {
  const [info, setInfo] = useState<Run | null>(null);
  const [known, setKnown] = useState<KnownRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const handlers = useRef(options);
  useEffect(() => {
    handlers.current = options;
  });

  useEffect(() => {
    if (!runId) {
      setKnown(null);
      setInfo(null);
      return;
    }
    let live = true;
    setError(null);
    setPaused(false);
    api.run(runId).then(
      (run) => {
        if (!live) return;
        setInfo(run);
        setKnown({ id: run.id, status: run.status, plan: run.plan });
      },
      // Without the run row the stream still says everything; only the thread link waits.
      () => live && setKnown({ id: runId, status: "running", plan: null }),
    );
    return () => {
      live = false;
    };
  }, [runId]);

  const onFinished = useCallback(() => {
    handlers.current.onFinished?.();
    if (runId) api.run(runId).then(setInfo, () => undefined);
  }, [runId]);
  const stream = useRunStream(known, onFinished);
  const { live, setLive, resume } = stream;

  const draft = live?.draftVersionId ?? null;
  useEffect(() => {
    if (draft) handlers.current.onDraft?.(draft);
  }, [draft]);

  const signal = useCallback(
    async (sig: RunSignal) => {
      if (!runId) return;
      setBusy(true);
      setError(null);
      try {
        await agentApi.signal(runId, sig);
        if (sig.name === "approve_plan" || sig.name === "reject_plan") resume();
        if (sig.name === "answer_question")
          setLive((current) => (current ? { ...current, question: null } : current));
        if (sig.name === "pause") setPaused(true);
        if (sig.name === "resume") setPaused(false);
      } catch (err) {
        setError(agentError(err));
      } finally {
        setBusy(false);
      }
    },
    [runId, resume, setLive],
  );

  return { ...stream, info, signal, busy, error, paused };
}
