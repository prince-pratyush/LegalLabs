import {
  AnswerText,
  Button,
  coverageLine,
  formatCost,
  PlanCard,
  QuestionCard,
  RunProgress,
  RunStatusText,
} from "@legallabs/ui";
import { ExternalLink } from "lucide-react";
import { paths } from "../router.js";
import type { LiveCitation } from "../thread/run-state.js";
import { openCitation } from "../viewer/open-citation.js";
import { useAgentRun } from "./use-agent-run.js";

const REASONS: Record<string, string> = {
  input_timeout: "No answer came within 72 hours, so the run stopped.",
  NONINTERACTIVE_INPUT_REQUIRED: "This scheduled run needed an answer it couldn't ask for.",
};

function open(citations: readonly LiveCitation[], n: number) {
  const citation = citations.find((c) => c.n === n);
  if (citation?.anchor) {
    const context = citations.flatMap((c) => (c.anchor ? [c.anchor] : []));
    openCitation(citation.anchor, { context });
  } else if (citation?.openUrl) {
    window.open(citation.openUrl, "_blank", "noopener");
  }
}

/** One agent run: its plan, progress, questions, controls and what it produced. */
export function RunView({
  runId,
  onDraft,
  onFinished,
  skipLabel,
}: {
  runId: string;
  onDraft?: (versionId: string) => void;
  onFinished?: () => void;
  skipLabel?: string;
}) {
  const run = useAgentRun(runId, {
    ...(onDraft ? { onDraft } : {}),
    ...(onFinished ? { onFinished } : {}),
  });
  const { live, info, signal, busy, error, paused, lost, reconnect } = run;
  if (!live) return <p className="text-dense text-fg-muted">Loading the run…</p>;

  const awaiting = live.status === "awaiting_approval" && !live.finished && live.plan;
  const active = !live.finished && !awaiting;
  const spent = live.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
  const reason = live.reason ? (REASONS[live.reason] ?? live.reason) : null;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <RunStatusText status={paused && active ? "paused" : live.status} />
        <span className="text-caption text-fg-muted tabular-nums">
          {formatCost(info?.cost_usd && info.cost_usd > spent ? info.cost_usd : spent)}
        </span>
        {info?.thread_id && (
          <a
            href={`#${paths.thread(info.thread_id)}`}
            className="inline-flex items-center gap-1 text-dense text-accent underline-offset-2 hover:underline"
          >
            Open thread
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        )}
        {active && (
          <div className="ml-auto flex gap-2">
            {paused ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => signal({ name: "resume" })}
              >
                Resume
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => signal({ name: "pause" })}
              >
                Pause
              </Button>
            )}
            <Button
              size="sm"
              variant="quiet"
              disabled={busy}
              onClick={() => signal({ name: "cancel", reason: "cancelled" })}
            >
              Cancel run
            </Button>
          </div>
        )}
      </div>
      {paused && active && (
        <p className="text-dense text-fg-muted">Paused. Nothing more runs until you resume.</p>
      )}
      {reason && live.finished && <p className="text-dense text-fg-muted">{reason}</p>}
      {error && (
        <p role="alert" className="text-dense text-destructive">
          {error}
        </p>
      )}
      {lost && (
        <p role="alert" className="text-dense text-destructive">
          Lost the connection to this run.{" "}
          <Button size="sm" variant="secondary" onClick={reconnect}>
            Reconnect
          </Button>
        </p>
      )}
      {awaiting && live.plan && (
        <PlanCard
          steps={live.plan.steps}
          costLow={live.plan.estimated_cost_usd.low}
          costHigh={live.plan.estimated_cost_usd.high}
          busy={busy}
          onApprove={() => signal({ name: "approve_plan" })}
          onEdit={(edits) => signal({ name: "approve_plan", edits })}
          onCancel={() => signal({ name: "reject_plan", reason: "Rejected before it ran." })}
        />
      )}
      {live.question && !live.finished && (
        <QuestionCard
          text={live.question.text}
          options={live.question.options}
          allowText={live.question.allowText}
          allowSkip={live.question.allowSkip}
          {...(skipLabel ? { skipLabel } : {})}
          busy={busy}
          onAnswer={(answer) =>
            live.question &&
            signal({ name: "answer_question", step_id: live.question.stepId, answer })
          }
        />
      )}
      {live.steps.length > 0 && (
        <RunProgress steps={live.steps} {...(live.coverage ? { coverage: live.coverage } : {})} />
      )}
      {live.steps.length === 0 && live.coverage && (
        <p className="text-caption text-fg-muted">{coverageLine(live.coverage)}</p>
      )}
      {live.messages.map((m, i) => (
        <AnswerText
          key={m.id}
          text={m.text}
          citations={live.citations}
          {...(i === live.messages.length - 1 && live.finished
            ? { ungrounded: live.ungrounded }
            : {})}
          streaming={active && i === live.messages.length - 1}
          onOpen={(n) => open(live.citations, n)}
        />
      ))}
      {live.outputs.some((o) => o.kind !== "message") && (
        <section aria-label="Outputs" className="grid gap-1">
          <h3 className="text-ui font-semibold">Outputs</h3>
          <ul className="grid gap-0.5 text-dense">
            {live.outputs
              .filter((o) => o.kind !== "message")
              .map((o, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: outputs arrive in order and never move
                <li key={i}>{o.title ?? (o.kind === "table" ? "A review table" : "A file")}</li>
              ))}
          </ul>
        </section>
      )}
      {live.error && (
        <p role="alert" className="text-dense text-destructive">
          {live.error.message}
        </p>
      )}
    </div>
  );
}
