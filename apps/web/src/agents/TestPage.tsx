import { atLeast } from "@legallabs/contracts";
import { Button, EmptyState, Label, Textarea } from "@legallabs/ui";
import { FlaskConical } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { type Agent, agentApi, agentError } from "./api.js";
import { RunView } from "./RunView.js";
import { agentHash, announceDraft, goAgents } from "./route.js";

type Turn = { kind: "test" | "change"; text: string; runId: string };

/**
 * A thread bound to the draft. Runs here are marked as tests and left out of usage;
 * "Request changes" revises the draft and tells the editor tab.
 */
export function TestPage({ agentId, version }: { agentId: string; version: string | null }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState(false);

  useEffect(() => {
    agentApi.get(agentId).then(setAgent, (err) => setError(agentError(err)));
  }, [agentId]);

  if (!agent) {
    return error ? (
      <p role="alert" className="text-destructive">
        {error}
      </p>
    ) : (
      <p className="text-fg-muted">Loading…</p>
    );
  }
  if (!atLeast(agent.my_access, "view")) {
    return (
      <EmptyState
        title="You can't test this agent"
        description="Testing needs View access."
        action={{
          label: "Back to the agent",
          onClick: () => goAgents({ page: "agent", agentId, tab: "instructions" }),
        }}
      />
    );
  }
  const canEdit = atLeast(agent.my_access, "edit");
  const pinned = version ?? agent.draft_version_id ?? agent.live_version_id;

  const start = async (kind: Turn["kind"], text: string) => {
    setBusy(true);
    setError(null);
    try {
      if (kind === "test") {
        const started = await agentApi.test(agentId, {
          inputs: text,
          ...(threadId ? { thread_id: threadId } : {}),
          ...(pinned ? { version_id: pinned } : {}),
        });
        setThreadId(started.thread_id);
        setTurns((t) => [...t, { kind, text, runId: started.run_id }]);
      } else {
        const started = await agentApi.requestChanges(agentId, {
          request: text,
          ...(threadId ? { thread_id: threadId } : {}),
        });
        setTurns((t) => [...t, { kind, text, runId: started.run_id }]);
      }
      return true;
    } catch (err) {
      setError(agentError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-w-0 max-w-3xl content-start gap-4">
      <header className="grid gap-1">
        <h1 className="flex items-center gap-2 text-title font-semibold">
          <FlaskConical aria-hidden className="size-5 text-accent" strokeWidth={1.5} />
          Test {agent.title}
        </h1>
        <p className="text-dense text-fg-muted">
          Test runs use the {version || agent.draft_version_id ? "draft" : "live version"} and
          aren't counted as usage. Their cost still counts.
        </p>
      </header>
      {updated && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg-raised p-3"
        >
          <span className="text-dense">
            The draft was updated. The editor tab now offers View changes.
          </span>
          <a
            className="text-dense text-accent underline"
            href={agentHash({ page: "agent", agentId, tab: "changes" })}
            target="_blank"
            rel="noopener"
          >
            Open the changes
          </a>
        </div>
      )}
      <ol aria-label="Test thread" className="grid gap-4">
        {turns.map((t) => (
          <li key={t.runId} className="grid gap-3">
            <p className="ml-auto max-w-[90%] rounded-lg bg-bg-raised px-3 py-2 text-ui whitespace-pre-wrap">
              {t.kind === "change" && <span className="font-medium">Request changes: </span>}
              {t.text}
            </p>
            <RunView
              runId={t.runId}
              onDraft={(draftVersionId) => {
                announceDraft({ agentId, draftVersionId });
                setUpdated(true);
              }}
            />
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="text-dense text-destructive">
          {error}
        </p>
      )}
      <Box
        label="Message"
        hint="What you'd give the agent in a real run."
        action="Run test"
        busy={busy}
        onSubmit={(text) => start("test", text)}
      />
      {canEdit && (
        <Box
          label="Request changes"
          hint="Say what to change; the builder revises the draft's instructions."
          action="Request changes"
          busy={busy}
          onSubmit={(text) => start("change", text)}
        />
      )}
    </div>
  );
}

function Box({
  label,
  hint,
  action,
  busy,
  onSubmit,
}: {
  label: string;
  hint: string;
  action: string;
  busy: boolean;
  onSubmit: (text: string) => Promise<boolean>;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (value && (await onSubmit(value))) setText("");
  };
  return (
    <form onSubmit={submit} className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={text}
        maxLength={5000}
        aria-describedby={`${id}-hint`}
        onChange={(e) => setText(e.target.value)}
        className="min-h-16"
      />
      <p id={`${id}-hint`} className="text-caption text-fg-muted">
        {hint}
      </p>
      <div>
        <Button type="submit" variant="secondary" disabled={busy || !text.trim()}>
          {action}
        </Button>
      </div>
    </form>
  );
}
