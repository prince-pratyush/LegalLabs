import { atLeast } from "@legallabs/contracts";
import {
  AgentEditorSkeleton,
  AnswerText,
  Button,
  EmptyState,
  Label,
  QuestionCard,
  Textarea,
} from "@legallabs/ui";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, type Message } from "../api.js";
import { type Agent, type AgentVersion, agentApi, agentError } from "./api.js";
import { EditorPanel } from "./EditorPanel.js";
import { goAgents } from "./route.js";
import { useAgentRun } from "./use-agent-run.js";

const FINISHED = ["done", "failed", "cancelled"];

/**
 * Describe mode: a builder thread on the left asks up to five questions and drafts; the
 * draft on the right updates each time the builder writes one.
 */
export function BuildPage({ agentId }: { agentId: string }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const a = await agentApi.get(agentId);
      setAgent(a);
      setVersions(await agentApi.versions(agentId));
    } catch (err) {
      setError(agentError(err));
    }
  }, [agentId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !agent)
    return (
      <p role="alert" className="text-destructive">
        {error}
      </p>
    );
  if (!agent) return <AgentEditorSkeleton />;
  if (!atLeast(agent.my_access, "edit")) {
    return (
      <EmptyState
        title="You can't edit this agent"
        description="Building needs Edit access."
        action={{
          label: "Back to the agent",
          onClick: () => goAgents({ page: "agent", agentId, tab: "instructions" }),
        }}
      />
    );
  }

  return (
    <div className="grid min-w-0 flex-1 content-start gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-title font-semibold">{agent.title}</h1>
        <Button
          variant="secondary"
          onClick={() => goAgents({ page: "agent", agentId, tab: "instructions" })}
        >
          Done
        </Button>
      </div>
      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <section
          aria-label="Builder"
          className="grid content-start gap-3 lg:border-r lg:border-border lg:pr-6"
        >
          <BuilderThread agentId={agentId} onDraft={load} />
        </section>
        <section aria-label="Draft" className="min-w-0">
          <EditorPanel agent={agent} versions={versions} onSaved={load} />
        </section>
      </div>
    </div>
  );
}

type Turn = { text: string; runId: string };

export function BuilderThread({ agentId, onDraft }: { agentId: string; onDraft: () => void }) {
  const id = useId();
  const [threadId, setThreadId] = useState<string | null>(null);
  const [history, setHistory] = useState<Message[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Picks up an earlier builder conversation, so leaving and coming back loses nothing.
  useEffect(() => {
    let live = true;
    agentApi
      .runs({ kind: "agent_builder", subjectId: agentId, limit: 1 })
      .then(async (runs) => {
        const last = runs[0];
        if (!live || !last?.thread_id) return;
        setThreadId(last.thread_id);
        const thread = await api.thread(last.thread_id);
        if (!live) return;
        setHistory(thread.messages);
        if (!FINISHED.includes(last.status)) setActiveRun(last.id);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [agentId]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message) return;
    setBusy(true);
    setError(null);
    try {
      const started = await agentApi.builder(agentId, {
        message,
        ...(threadId ? { thread_id: threadId } : {}),
      });
      setThreadId(started.thread_id);
      setTurns((t) => [...t, { text: message, runId: started.run_id }]);
      setActiveRun(started.run_id);
      setText("");
    } catch (err) {
      setError(agentError(err));
    } finally {
      setBusy(false);
    }
  };

  const fresh = history.length === 0 && turns.length === 0;
  return (
    <div className="grid gap-3">
      {fresh && (
        <p className="text-dense text-fg-muted">
          Describe what the agent should do, for example: “Review inbound NDAs against our playbook
          and draft a summary email.” It asks a few questions, then drafts the instructions on the
          right.
        </p>
      )}
      <ol aria-label="Builder conversation" className="grid gap-3">
        {history.map((m) => (
          <li key={m.id}>
            <Bubble who={m.role} text={m.content} />
          </li>
        ))}
        {activeRun && turns.length === 0 && (
          <li>
            <BuilderTurn runId={activeRun} onDraft={onDraft} onDone={() => setActiveRun(null)} />
          </li>
        )}
        {turns.map((t) => (
          <li key={t.runId} className="grid gap-3">
            <Bubble who="user" text={t.text} />
            <BuilderTurn
              runId={t.runId}
              onDraft={onDraft}
              onDone={() => setActiveRun((r) => (r === t.runId ? null : r))}
            />
          </li>
        ))}
      </ol>
      <form onSubmit={send} className="grid gap-2">
        <Label htmlFor={id} className="text-dense">
          {fresh ? "What should the agent do?" : "Reply to the builder"}
        </Label>
        <Textarea
          id={id}
          value={text}
          maxLength={5000}
          disabled={busy || activeRun !== null}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {error && (
          <p role="alert" className="text-dense text-destructive">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" disabled={busy || activeRun !== null || !text.trim()}>
            Send
          </Button>
        </div>
      </form>
    </div>
  );
}

function Bubble({ who, text }: { who: "user" | "assistant"; text: string }) {
  return who === "user" ? (
    <p className="ml-auto max-w-[90%] rounded-lg bg-bg-raised px-3 py-2 text-ui whitespace-pre-wrap">
      {text}
    </p>
  ) : (
    <AnswerText text={text} citations={[]} onOpen={() => {}} />
  );
}

/** One builder run: what it says, and the question it is waiting on. */
function BuilderTurn({
  runId,
  onDraft,
  onDone,
}: {
  runId: string;
  onDraft: () => void;
  onDone: () => void;
}) {
  const { live, signal, busy, error } = useAgentRun(runId, {
    onDraft: () => onDraft(),
    onFinished: onDone,
  });
  if (!live) return null;
  const working = !live.finished && !live.question;
  return (
    <div className="grid gap-3">
      {live.messages.map((m) => (
        <AnswerText key={m.id} text={m.text} citations={[]} onOpen={() => {}} />
      ))}
      {live.question && !live.finished && (
        <QuestionCard
          text={live.question.text}
          options={live.question.options}
          allowText={live.question.allowText}
          allowSkip={live.question.allowSkip}
          skipLabel="Skip remaining"
          busy={busy}
          error={error}
          onAnswer={(answer) =>
            live.question &&
            signal({ name: "answer_question", step_id: live.question.stepId, answer })
          }
        />
      )}
      {working && (
        <p aria-live="polite" className="text-dense text-fg-muted">
          {live.steps.find((s) => s.status === "running")?.title ?? "Working…"}
        </p>
      )}
      {live.error && (
        <p role="alert" className="text-dense text-destructive">
          {live.error.message}
        </p>
      )}
    </div>
  );
}
