import { FINISHED, isTerminal, parseCitationPath } from "@legallabs/contracts";
import {
  AnswerText,
  AnswerTextSkeleton,
  Button,
  ComposerSkeleton,
  EmptyState,
  ModelBadge,
  PlanCard,
  PlanCardSkeleton,
  RunProgress,
} from "@legallabs/ui";
import { FilePen, Share2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type AskInput,
  api,
  type Message,
  messageOf,
  type ScopeOptions,
  streamRun,
  type Thread,
} from "../api.js";
import { DraftsPanel } from "../drafts/DraftsPanel.js";
import { navigate, paths } from "../router.js";
import { SharePanel } from "../share/SharePanel.js";
import { Shell } from "../shell.js";
import { openCitation } from "../viewer/open-citation.js";
import { toAnswerCitation } from "./compose.js";
import { type LiveCitation, type LiveRun, reduceRun, startRun } from "./run-state.js";
import { SourcesPanel } from "./SourcesPanel.js";
import { ThreadComposer } from "./ThreadComposer.js";

/** Verified citations open the viewer (or the authority); flagged ones never link. */
function follow(citation: LiveCitation) {
  if (citation.status !== "ok" || !citation.openUrl) return false;
  if (citation.openUrl.startsWith("/d/")) {
    const target = parseCitationPath(citation.openUrl);
    if (!target) return false;
    openCitation(target, { documentName: citation.documentName, quote: citation.quote });
    return true;
  }
  if (/^https?:\/\//.test(citation.openUrl)) {
    window.open(citation.openUrl, "_blank", "noopener,noreferrer");
    return true;
  }
  return false;
}

type Panel =
  | { kind: "sources"; answerId: string; n?: number }
  | { kind: "share" }
  | { kind: "drafts"; draftId?: string }
  | null;

export function ThreadScreen({
  threadId,
  onChanged,
}: {
  /** Null for a new thread. */
  threadId: string | null;
  /** The thread list changed, e.g. a question started a new thread. */
  onChanged: () => void;
}) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [loadError, setLoadError] = useState<ApiError | Error | null>(null);
  const [options, setOptions] = useState<ScopeOptions | null>(null);
  const [live, setLive] = useState<LiveRun | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [attempt, setAttempt] = useState(0);
  const [planBusy, setPlanBusy] = useState(false);
  const following = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!threadId) return null;
    const fresh = await api.thread(threadId);
    setThread(fresh);
    return fresh;
  }, [threadId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the load on Retry
  useEffect(() => {
    setLoadError(null);
    load().catch((err) => setLoadError(err instanceof Error ? err : new Error(String(err))));
  }, [load, attempt]);

  useEffect(() => {
    api.scopeOptions().then(setOptions, () => setOptions({ vaults: [], sources: [], models: [] }));
  }, []);

  // Follow whichever run is still going; a reload picks it up again from the start.
  const active = thread?.runs.find((run) => !FINISHED.includes(run.status)) ?? null;
  const activeId = active?.id ?? null;
  // Read when the stream starts, so a waiting plan shows before any event replays.
  const activeRun = useRef(active);
  activeRun.current = active;
  useEffect(() => {
    if (!activeId || following.current === activeId) return;
    following.current = activeId;
    const known = activeRun.current;
    setLive(startRun(activeId, known ? { status: known.status, plan: known.plan } : {}));
    let settled = false;
    const close = streamRun(
      activeId,
      (event) => {
        setLive((run) => (run && run.runId === activeId ? reduceRun(run, event) : run));
        if (isTerminal(event) && !settled) {
          settled = true;
          // The saved message replaces the streamed text, with its final citations.
          load().then(
            () => setLive((run) => (run?.runId === activeId && !run.error ? null : run)),
            () => undefined,
          );
        }
      },
      { onDrop: () => load().catch(() => undefined) },
    );
    return () => {
      close();
      following.current = null;
    };
  }, [activeId, load]);

  const ask = async (input: AskInput) => {
    setSending(true);
    setSendError(null);
    try {
      if (!threadId) {
        const accepted = await api.ask(input);
        onChanged();
        navigate(paths.thread(accepted.thread_id));
      } else {
        await api.reply(threadId, input);
        setLive(null);
        await load();
        onChanged();
      }
      return true;
    } catch (err) {
      setSendError(messageOf(err));
      return false;
    } finally {
      setSending(false);
    }
  };

  // Asks the same question again over the thread's own scope.
  const retry = (questionId: string) => {
    const question = thread?.messages.find((m) => m.id === questionId);
    if (!thread || !question) return;
    setLive(null);
    void ask({
      content: question.content,
      scope: {
        document_ids: thread.documents.map((d) => d.id),
        vault_ids: thread.vault_ids,
        sources: thread.sources,
      },
    });
  };

  const draftFrom = async (messageId: string) => {
    if (!thread) return;
    setSendError(null);
    try {
      const draft = await api.createDraft(thread.id, messageId);
      setPanel({ kind: "drafts", draftId: draft.id });
    } catch (err) {
      setSendError(messageOf(err));
    }
  };

  const stop = () => {
    if (live && !live.finished) api.cancel(live.runId).catch(() => undefined);
  };

  const duplicate = async () => {
    if (!thread) return;
    try {
      const copy = await api.duplicate(thread.id);
      onChanged();
      navigate(paths.thread(copy.thread_id));
    } catch (err) {
      setSendError(messageOf(err));
    }
  };

  const cite = (answerId: string, citations: readonly LiveCitation[], n: number) => {
    const citation = citations.find((c) => c.n === n);
    setPanel({ kind: "sources", answerId, n });
    if (citation) follow(citation);
  };

  const awaiting = live?.status === "awaiting_approval" && !live.finished;
  // While a plan waits, the composer is blocked rather than offering Stop.
  const streaming = sending || (live !== null && !live.finished && !awaiting);

  const decide = async (action: () => Promise<void>) => {
    setPlanBusy(true);
    setSendError(null);
    try {
      await action();
    } catch (err) {
      setSendError(messageOf(err));
    } finally {
      setPlanBusy(false);
    }
  };
  const liveQuestion = live ? thread?.runs.find((r) => r.id === live.runId)?.question_id : null;
  // A run that failed before saving an answer still deserves a way forward.
  const lastRun = thread?.runs.at(-1);
  const failed =
    !live && lastRun?.status === "failed" && !lastRun.message_id ? lastRun.question_id : null;

  const answerCitations = (answerId: string): LiveCitation[] => {
    if (live && answerId === live.runId) return live.citations;
    return thread?.messages.find((m) => m.id === answerId)?.citations.map(toAnswerCitation) ?? [];
  };

  const panelNode =
    panel?.kind === "drafts" && thread ? (
      <DraftsPanel
        key={panel.draftId ?? "drafts"}
        threadId={thread.id}
        {...(panel.draftId ? { draftId: panel.draftId } : {})}
        onClose={() => setPanel(null)}
      />
    ) : panel?.kind === "share" && thread ? (
      <SharePanel threadId={thread.id} onClose={() => setPanel(null)} />
    ) : panel?.kind === "sources" ? (
      <SourcesPanel
        citations={answerCitations(panel.answerId)}
        {...(panel.n !== undefined ? { activeN: panel.n } : {})}
        onOpen={(n) => cite(panel.answerId, answerCitations(panel.answerId), n)}
        onFlagged={(n) => setPanel({ kind: "sources", answerId: panel.answerId, n })}
        onClose={() => setPanel(null)}
      />
    ) : null;

  const lastAnswer = thread?.messages.findLast((m) => m.role === "assistant");
  const togglePanel = () =>
    setPanel((open) =>
      open ? null : lastAnswer ? { kind: "sources", answerId: lastAnswer.id } : null,
    );

  if (threadId && loadError) {
    const missing = loadError instanceof ApiError && loadError.status === 404;
    return (
      <Shell>
        <EmptyState
          title={missing ? "Thread not found" : "This thread couldn't be opened"}
          description={
            missing ? "It may have been deleted, or you no longer have access." : loadError.message
          }
          action={
            missing
              ? { label: "Start a new thread", onClick: () => navigate(paths.new) }
              : { label: "Try again", onClick: () => setAttempt((n) => n + 1) }
          }
        />
      </Shell>
    );
  }

  if (threadId && !thread) {
    return (
      <Shell>
        <div className="mx-auto grid max-w-[880px] gap-6 px-8 py-6" aria-busy>
          <span className="sr-only">Loading the thread…</span>
          <AnswerTextSkeleton />
          <AnswerTextSkeleton />
          <ComposerSkeleton />
        </div>
      </Shell>
    );
  }

  return (
    <Shell panel={panelNode} onTogglePanel={togglePanel}>
      <div className="mx-auto flex min-h-full max-w-[880px] flex-col gap-6 px-8 py-6">
        {thread ? (
          <header className="flex items-start justify-between gap-4">
            <h1 className="text-title font-semibold">{thread.title}</h1>
            <div className="flex shrink-0 gap-2">
              <Button variant="quiet" size="sm" onClick={() => setPanel({ kind: "drafts" })}>
                <FilePen aria-hidden />
                Drafts
              </Button>
              {!thread.read_only && (
                <Button variant="secondary" size="sm" onClick={() => setPanel({ kind: "share" })}>
                  <Share2 aria-hidden />
                  Share
                </Button>
              )}
            </div>
          </header>
        ) : (
          <header className="grid gap-1">
            <h1 className="text-title font-semibold">New thread</h1>
            <p className="text-fg-muted">
              Attach files, a vault or a source, then ask. Every answer shows where it came from,
              and whether that source was checked.
            </p>
          </header>
        )}

        {thread && (
          <ol className="grid gap-6">
            {thread.messages.map((message) => (
              <li key={message.id} className="grid gap-3">
                {message.role === "user" ? (
                  <UserBubble message={message} />
                ) : (
                  <SavedAnswer
                    message={message}
                    selected={panel?.kind === "sources" && panel.answerId === message.id}
                    onCite={(n) => cite(message.id, message.citations.map(toAnswerCitation), n)}
                    onSources={() => setPanel({ kind: "sources", answerId: message.id })}
                    {...(thread.read_only ? {} : { onDraft: () => void draftFrom(message.id) })}
                  />
                )}
                {live && message.id === liveQuestion && (
                  <LiveAnswer
                    run={live}
                    onCite={(n) => cite(live.runId, live.citations, n)}
                    onRetry={() => retry(message.id)}
                    planBusy={planBusy}
                    onApprove={() => decide(() => api.approve(live.runId))}
                    onEditPlan={(text) => decide(() => api.editPlan(live.runId, text))}
                    onCancelPlan={() => decide(() => api.cancel(live.runId))}
                  />
                )}
                {message.id === failed && (
                  <ErrorCard
                    message="This answer couldn't be finished."
                    onRetry={() => retry(message.id)}
                  />
                )}
              </li>
            ))}
          </ol>
        )}

        <div className="sticky bottom-0 mt-auto grid gap-2 bg-bg pt-2 pb-4">
          {sendError && (
            <p role="alert" className="text-dense text-destructive">
              {sendError}
            </p>
          )}
          {thread?.read_only ? (
            <div
              role="note"
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-bg-subtle p-3"
            >
              <p className="text-ui">This thread was shared with you, so it's read-only.</p>
              <Button onClick={duplicate}>Duplicate to continue</Button>
            </div>
          ) : (
            <ThreadComposer
              key={thread?.id ?? "new"}
              thread={thread}
              options={options}
              streaming={streaming}
              {...(awaiting ? { blockedReason: "Answer above to continue." } : {})}
              onSend={ask}
              onStop={stop}
            />
          )}
        </div>
      </div>
    </Shell>
  );
}

function UserBubble({ message }: { message: Message }) {
  return (
    <div className="max-w-[72ch] justify-self-end rounded-xl bg-bg-subtle px-4 py-2 text-prose whitespace-pre-wrap">
      {message.content}
    </div>
  );
}

function SavedAnswer({
  message,
  selected,
  onCite,
  onSources,
  onDraft,
}: {
  message: Message;
  selected: boolean;
  onCite: (n: number) => void;
  onSources: () => void;
  /** Absent on a read-only thread. */
  onDraft?: () => void;
}) {
  const fallbackFrom =
    message.requested_model && message.requested_model !== message.model
      ? message.requested_model
      : null;
  // A reply with no model is the fixed "not found" answer, which claims nothing.
  const unsupported = message.model !== null && !message.citations.some((c) => c.status === "ok");
  return (
    <article className="grid gap-2" aria-label="Answer" data-testid={`answer-${message.id}`}>
      {unsupported && (
        <p role="note" className="border-l-4 border-warning py-2 pl-3 font-semibold text-warning">
          Nothing in this answer was checked against your documents. Don't rely on it without
          reading the source.
        </p>
      )}
      <AnswerText
        text={message.content}
        citations={message.citations.map(toAnswerCitation)}
        ungrounded={message.ungrounded}
        onOpen={onCite}
      />
      <div className="flex flex-wrap items-center gap-2">
        <ModelBadge
          model={message.model}
          inputTokens={message.input_tokens ?? 0}
          outputTokens={message.output_tokens ?? 0}
          costUsd={message.cost_usd}
          {...(fallbackFrom ? { fallbackFrom } : {})}
        />
        {message.citations.length > 0 && (
          <Button variant="quiet" size="sm" aria-pressed={selected} onClick={onSources}>
            Sources ({message.citations.length})
          </Button>
        )}
        {onDraft && (
          <Button variant="quiet" size="sm" onClick={onDraft}>
            <FilePen aria-hidden />
            Draft from this answer
          </Button>
        )}
      </div>
    </article>
  );
}

function LiveAnswer({
  run,
  onCite,
  onRetry,
  planBusy,
  onApprove,
  onEditPlan,
  onCancelPlan,
}: {
  run: LiveRun;
  onCite: (n: number) => void;
  onRetry: () => void;
  planBusy: boolean;
  onApprove: () => void;
  onEditPlan: (instruction: string) => void;
  onCancelPlan: () => void;
}) {
  // Nothing is read until a person approves the plan and its cost.
  if (run.status === "awaiting_approval" && !run.finished) {
    return run.plan ? (
      <PlanCard
        steps={run.plan.steps}
        costLow={run.plan.estimated_cost_usd.low}
        costHigh={run.plan.estimated_cost_usd.high}
        onApprove={onApprove}
        onEdit={onEditPlan}
        onCancel={onCancelPlan}
        busy={planBusy}
      />
    ) : (
      <PlanCardSkeleton />
    );
  }
  return (
    <article className="grid gap-3" aria-label="Answer in progress">
      {run.status === "planned" && !run.finished && (
        <p className="text-dense text-fg-muted">Planning the analysis…</p>
      )}
      {(run.steps.length > 0 || run.coverage) && !run.finished && (
        <RunProgress steps={run.steps} {...(run.coverage ? { coverage: run.coverage } : {})} />
      )}
      {run.text ? (
        <AnswerText
          text={run.text}
          citations={run.citations}
          ungrounded={run.ungrounded}
          onOpen={onCite}
          streaming={!run.finished}
        />
      ) : !run.finished ? (
        <AnswerTextSkeleton />
      ) : null}
      {run.status === "cancelled" && <p className="text-dense text-fg-muted">Stopped.</p>}
      {run.error && <ErrorCard message={run.error.message} onRetry={onRetry} />}
    </article>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive p-3"
    >
      <p className="text-ui">{message}</p>
      <Button size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
