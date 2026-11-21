import { NudgeChip } from "@legallabs/ui";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api.js";
import { agentApi } from "./api.js";
import { goAgents } from "./route.js";

const WAIT_MS = 600;
const MIN_CHARS = 12;

export type Nudge = { agent_id: string; title: string };

// Turned off for the page once the server says nudges aren't offered here.
let unavailable = false;

/**
 * Asks, once typing pauses, whether a shared agent fits what is being written. One
 * suggestion at a time; a dismissed agent isn't offered again in this thread.
 */
export function useNudge(text: string, threadKey: string, wait = WAIT_MS) {
  const [nudge, setNudge] = useState<Nudge | null>(null);
  const dismissed = useRef(new Map<string, Set<string>>());
  const prompt = text.trim();

  useEffect(() => {
    if (unavailable || prompt.length < MIN_CHARS) {
      setNudge(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      agentApi.nudge(prompt.slice(0, 2000)).then(
        (found) => {
          if (!live) return;
          const gone = dismissed.current.get(threadKey);
          setNudge(found && !gone?.has(found.agent_id) ? found : null);
        },
        (err) => {
          if (err instanceof ApiError && err.status === 404) unavailable = true;
          if (live) setNudge(null);
        },
      );
    }, wait);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [prompt, threadKey, wait]);

  const dismiss = () => {
    if (!nudge) return;
    const gone = dismissed.current.get(threadKey) ?? new Set<string>();
    gone.add(nudge.agent_id);
    dismissed.current.set(threadKey, gone);
    agentApi.dismissNudge(nudge.agent_id).catch(() => undefined);
    setNudge(null);
  };

  return { nudge, dismiss };
}

/** The strip above the composer; Run opens the agent, never runs it by itself. */
export function AgentNudge({ text, threadKey }: { text: string; threadKey: string }) {
  const { nudge, dismiss } = useNudge(text, threadKey);
  if (!nudge) return null;
  return (
    <NudgeChip
      title={nudge.title}
      onRun={() => goAgents({ page: "agent", agentId: nudge.agent_id, tab: "instructions" })}
      onDismiss={dismiss}
    />
  );
}

/** For tests: forget that nudges were found unavailable. */
export const resetNudges = () => {
  unavailable = false;
};
