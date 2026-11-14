import { type CitationEvent, FINISHED, type RunEvent, type RunStatus } from "@legallabs/contracts";
import type { AnswerCitation, Range, RunCoverage, RunStep } from "@legallabs/ui";

export interface LiveCitation extends AnswerCitation {
  /** A deep link or an authority URL, only for a verified citation. */
  openUrl: string | null;
}

export interface LiveRun {
  runId: string;
  status: RunStatus;
  text: string;
  citations: LiveCitation[];
  steps: RunStep[];
  coverage: RunCoverage | null;
  /** Sentences the verifier found no source for, sent with `done`. */
  ungrounded: Range[];
  error: { code: string; message: string; retryable: boolean } | null;
  /** Set by `done`: the saved answer can now be fetched. */
  messageId: string | null;
  finished: boolean;
}

export const startRun = (runId: string): LiveRun => ({
  runId,
  status: "running",
  text: "",
  citations: [],
  steps: [],
  coverage: null,
  ungrounded: [],
  error: null,
  messageId: null,
  finished: false,
});

function citationOf(event: CitationEvent, at: number): LiveCitation {
  return {
    n: event.ordinal,
    // Used only when the text lacks the [[c:N]] placeholder.
    at,
    status: event.verified,
    documentName: event.document?.name ?? event.authority?.title ?? null,
    page: event.document?.page_no ?? null,
    quote: event.quote,
    openUrl: event.verified === "ok" ? (event.open_url ?? null) : null,
  };
}

const STEP_STATUS = { started: "running", finished: "done", failed: "failed" } as const;

/** Folds one streamed event into what the thread shows while a run is live. */
export function reduceRun(run: LiveRun, event: RunEvent): LiveRun {
  switch (event.type) {
    case "status":
      return {
        ...run,
        status: event.status,
        finished: run.finished || FINISHED.includes(event.status),
      };
    case "token":
      return { ...run, text: run.text + event.delta };
    case "citation": {
      const next = citationOf(event.citation, run.text.length);
      return { ...run, citations: [...run.citations.filter((c) => c.n !== next.n), next] };
    }
    case "step": {
      const step: RunStep = {
        id: event.step_id,
        title: event.title,
        status: STEP_STATUS[event.status],
        ...(event.model ? { detail: event.model } : {}),
        ...(event.cost_usd !== undefined ? { costUsd: event.cost_usd } : {}),
      };
      const known = run.steps.some((s) => s.id === step.id);
      return {
        ...run,
        steps: known ? run.steps.map((s) => (s.id === step.id ? step : s)) : [...run.steps, step],
      };
    }
    case "coverage":
      return {
        ...run,
        coverage: {
          docsRead: event.coverage.docs_read,
          docsInScope: event.coverage.docs_in_scope,
          pagesRead: event.coverage.pages_read,
          pagesInScope: event.coverage.pages_in_scope,
        },
      };
    case "done":
      return {
        ...run,
        status: "done",
        messageId: event.message_id,
        ungrounded: event.ungrounded ?? [],
        finished: true,
      };
    case "error":
      return {
        ...run,
        error: { code: event.code, message: event.message, retryable: event.retryable },
        finished: run.finished || !event.retryable,
      };
    default:
      return run;
  }
}
