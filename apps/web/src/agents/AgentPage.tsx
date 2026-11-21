import { atLeast, diffList, diffWords } from "@legallabs/contracts";
import {
  AccessBadge,
  AgentActivity,
  AgentActivitySkeleton,
  AgentChanges,
  AgentEditor,
  AgentEditorSkeleton,
  AgentStatusBadge,
  AgentVersionList,
  Button,
  type ChangedItem,
  ConfirmDialog,
  EmptyState,
  formatWhen,
  Label,
  PANEL_MIN,
  SidePanel,
  Textarea,
} from "@legallabs/ui";
import { Play } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { ApiError } from "../api.js";
import { SchedulePanel, SharePanel } from "./AgentPanels.js";
import { type Agent, type AgentVersion, agentApi, agentError } from "./api.js";
import { contentOf, EditorPanel } from "./EditorPanel.js";
import { type AgentTab, goAgents, listenForDrafts, openTest } from "./route.js";

type Activity = Awaited<ReturnType<typeof agentApi.activity>>;

const items = (list: { kind: string; label: string; name?: string; source?: string }[]) =>
  list.map(
    (x): ChangedItem => ({
      kind: x.kind as ChangedItem["kind"],
      label: x.label,
      name: x.name ?? x.source ?? "",
    }),
  );

/** Changes between two saved versions, computed here so any pair can be compared. */
function changesBetween(from: AgentVersion, to: AgentVersion) {
  return {
    ops: diffWords(from.instructions, to.instructions),
    attachments: diffList(from.attachments, to.attachments, (x) => `${x.kind}:${x.ref}`),
    sources: diffList(from.sources, to.sources, (x) => `${x.kind}:${x.source}`),
  };
}

export function AgentPage({ agentId, tab }: { agentId: string; tab: AgentTab }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"schedule" | "share" | "run" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [news, setNews] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const a = await agentApi.get(agentId);
      setAgent(a);
      setVersions(atLeast(a.my_access, "view") ? await agentApi.versions(agentId) : []);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else setError(agentError(err));
    }
  }, [agentId]);
  useEffect(() => {
    void load();
  }, [load]);

  // The test tab says when "Request changes" wrote a new draft.
  useEffect(
    () =>
      listenForDrafts((n) => {
        if (n.agentId !== agentId) return;
        setNews(true);
        void load();
      }),
    [agentId, load],
  );

  if (missing) {
    return (
      <EmptyState
        title="Agent not found"
        description="It may have been deleted, or it isn't shared with you."
        action={{ label: "All agents", onClick: () => goAgents({ page: "list" }) }}
      />
    );
  }
  if (!agent) {
    return error ? (
      <p role="alert" className="text-destructive">
        {error}
      </p>
    ) : (
      <AgentEditorSkeleton />
    );
  }

  const canView = atLeast(agent.my_access, "view");
  const canEdit = atLeast(agent.my_access, "edit");
  const full = agent.my_access === "full";
  const live = versions.find((v) => v.id === agent.live_version_id) ?? null;
  const draft = versions.find((v) => v.id === agent.draft_version_id) ?? null;
  const go = (t: AgentTab) => goAgents({ page: "agent", agentId, tab: t });
  const tabs: { id: AgentTab; label: string; show: boolean }[] = [
    { id: "instructions", label: "Instructions", show: true },
    { id: "changes", label: "Changes", show: canView && draft !== null },
    { id: "versions", label: "Versions", show: canView },
    { id: "activity", label: "Activity", show: true },
  ];

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(agentError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 gap-0">
      <div className="grid min-w-0 flex-1 content-start gap-4">
        <header className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-title font-semibold">{agent.title}</h1>
            <AgentStatusBadge status={agent.status} />
            <AccessBadge level={agent.my_access} />
          </div>
          {agent.description && (
            <p className="max-w-prose text-ui text-fg-muted">{agent.description}</p>
          )}
          <p className="flex flex-wrap gap-x-3 text-caption text-fg-muted">
            {agent.practice_areas.length > 0 && <span>{agent.practice_areas.join(", ")}</span>}
            <span>
              {agent.stats.runs} {agent.stats.runs === 1 ? "run" : "runs"}
            </span>
            {agent.schedule?.next_run_at && agent.schedule.status === "active" && (
              <span>Next run {formatWhen(agent.schedule.next_run_at)}</span>
            )}
            {agent.schedule?.status === "paused" && <span>Schedule paused</span>}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={agent.status !== "live"}
              title={agent.status === "live" ? undefined : "Save the agent before running it."}
              onClick={() => setPanel("run")}
            >
              <Play aria-hidden />
              Run agent
            </Button>
            {canView && (
              <Button
                variant="secondary"
                onClick={() => openTest(agentId, agent.draft_version_id ?? agent.live_version_id)}
              >
                Test agent
              </Button>
            )}
            {canEdit && (
              <Button variant="secondary" onClick={() => goAgents({ page: "build", agentId })}>
                Build with the assistant
              </Button>
            )}
            <Button variant="secondary" onClick={() => setPanel("schedule")}>
              Schedule
            </Button>
            {full && (
              <Button variant="secondary" onClick={() => setPanel("share")}>
                Share
              </Button>
            )}
            {canView && (
              <Button
                variant="quiet"
                disabled={busy || agent.status !== "live"}
                onClick={() =>
                  act(async () => {
                    const copy = await agentApi.duplicate(agentId);
                    goAgents({ page: "agent", agentId: copy.id, tab: "instructions" });
                  })
                }
              >
                Duplicate
              </Button>
            )}
            {canView && (
              <Button variant="quiet" asChild>
                <a href={agentApi.exportUrl(agentId)} download>
                  Export
                </a>
              </Button>
            )}
            {full && (
              <Button
                variant="quiet"
                className="text-destructive"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            )}
          </div>
        </header>

        {news && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg-raised p-3"
          >
            <span className="text-dense">The draft was changed from the test tab.</span>
            <Button
              size="sm"
              onClick={() => {
                setNews(false);
                go("changes");
              }}
            >
              View changes
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setNews(false)}>
              Dismiss
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}

        <nav aria-label="Agent sections" className="flex flex-wrap gap-1 border-b border-border">
          {tabs
            .filter((t) => t.show)
            .map((t) => (
              <button
                key={t.id}
                type="button"
                aria-current={tab === t.id ? "page" : undefined}
                onClick={() => go(t.id)}
                className="-mb-px border-b-2 border-transparent px-3 py-1.5 text-ui text-fg-muted hover:text-fg aria-[current=page]:border-accent aria-[current=page]:text-fg"
              >
                {t.label}
              </button>
            ))}
        </nav>

        {tab === "instructions" &&
          (canEdit ? (
            <EditorPanel agent={agent} versions={versions} onSaved={load} />
          ) : canView ? (
            <AgentEditor
              value={contentOf(live ?? draft)}
              onChange={() => {}}
              attachChoices={[]}
              sourceChoices={[]}
              onSave={() => {}}
              hasLive
              readOnly
            />
          ) : (
            <p className="text-dense text-fg-muted">
              You can run this agent. Ask its owner for View access to read its instructions.
            </p>
          ))}
        {tab === "changes" && canView && (
          <ChangesTab agent={agent} live={live} draft={draft} canEdit={canEdit} onChanged={load} />
        )}
        {tab === "versions" && canView && <VersionsTab agent={agent} versions={versions} />}
        {tab === "activity" && <ActivityTab agentId={agentId} />}
      </div>

      {panel === "run" && (
        <SidePanel
          title={`Run ${agent.title}`}
          onClose={() => setPanel(null)}
          width={PANEL_MIN + 40}
        >
          <RunBox agentId={agentId} />
        </SidePanel>
      )}
      {panel === "schedule" && (
        <SidePanel title="Schedule" onClose={() => setPanel(null)} width={PANEL_MIN + 40}>
          <SchedulePanel agent={agent} onChanged={load} />
        </SidePanel>
      )}
      {panel === "share" && (
        <SidePanel
          title={`Share ${agent.title}`}
          onClose={() => setPanel(null)}
          width={PANEL_MIN + 60}
        >
          <SharePanel agent={agent} />
        </SidePanel>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${agent.title}?`}
        description="It stops being available to everyone it's shared with, and its schedules pause. Past runs and their threads are kept."
        confirmLabel="Delete agent"
        destructive
        onConfirm={() =>
          act(async () => {
            await agentApi.remove(agentId);
            goAgents({ page: "list" });
          })
        }
      />
    </div>
  );
}

/** Inputs go in as the first message; the run opens on its own page. */
function RunBox({ agentId }: { agentId: string }) {
  const id = useId();
  const [inputs, setInputs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const started = await agentApi.run(agentId, inputs.trim() ? { inputs: inputs.trim() } : {});
      goAgents({ page: "run", agentId, runId: started.run_id });
    } catch (err) {
      setError(agentError(err));
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor={id}>Inputs</Label>
        <Textarea
          id={id}
          value={inputs}
          maxLength={5000}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setInputs(e.target.value)}
        />
        <p id={`${id}-hint`} className="text-caption text-fg-muted">
          Anything the agent needs to start, such as the document or question. It may ask for more.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-dense text-destructive">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" disabled={busy}>
          Start run
        </Button>
      </div>
    </form>
  );
}

function ChangesTab({
  agent,
  live,
  draft,
  canEdit,
  onChanged,
}: {
  agent: Agent;
  live: AgentVersion | null;
  draft: AgentVersion | null;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [server, setServer] = useState<Awaited<ReturnType<typeof agentApi.diff>> | null>(null);

  useEffect(() => {
    if (!live || !draft) return;
    agentApi.diff(agent.id, live.id, draft.id).then(setServer, () => setServer(null));
  }, [agent.id, live, draft]);

  if (!draft) return <p className="text-dense text-fg-muted">There is no draft.</p>;
  const empty = { ...draft, instructions: "", attachments: [], sources: [] };
  const local = changesBetween(live ?? empty, draft);
  const shown = server
    ? {
        ops: server.instructions_diff,
        attachments: server.attachments,
        sources: server.sources,
      }
    : local;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(agentError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3">
      {live === null && (
        <p className="text-dense text-fg-muted">
          Nothing is live yet; this compares with an empty agent.
        </p>
      )}
      <AgentChanges
        ops={shown.ops}
        attachments={{
          added: items(shown.attachments.added),
          removed: items(shown.attachments.removed),
        }}
        sources={{ added: items(shown.sources.added), removed: items(shown.sources.removed) }}
        fromLabel={live ? `Live (version ${live.no})` : "Empty"}
        toLabel={`Draft (version ${draft.no})`}
        busy={busy}
        {...(canEdit
          ? {
              onAccept: () =>
                run(() =>
                  agentApi.saveVersion(agent.id, {
                    ...contentOf(draft),
                    sources: draft.sources,
                    attachments: draft.attachments,
                    promote: true,
                  }),
                ),
              onDiscard: () => run(() => agentApi.discardDraft(agent.id)),
            }
          : {})}
      />
      {error && (
        <p role="alert" className="text-dense text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function VersionsTab({ agent, versions }: { agent: Agent; versions: readonly AgentVersion[] }) {
  const [compare, setCompare] = useState<AgentVersion | null>(null);
  const before = compare ? versions.find((v) => v.no < compare.no) : undefined;
  return (
    <div className="grid gap-4">
      <AgentVersionList
        versions={versions.map((v) => ({
          id: v.id,
          no: v.no,
          createdAt: v.created_at,
          live: v.id === agent.live_version_id,
          draft: v.id === agent.draft_version_id,
        }))}
        onCompare={(row) => setCompare(versions.find((v) => v.id === row.id) ?? null)}
      />
      {compare && before && (
        <AgentChanges
          {...(() => {
            const c = changesBetween(before, compare);
            return {
              ops: c.ops,
              attachments: {
                added: items(c.attachments.added),
                removed: items(c.attachments.removed),
              },
              sources: { added: items(c.sources.added), removed: items(c.sources.removed) },
            };
          })()}
          fromLabel={`Version ${before.no}`}
          toLabel={`Version ${compare.no}`}
        />
      )}
    </div>
  );
}

function ActivityTab({ agentId }: { agentId: string }) {
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    agentApi.activity(agentId).then(setActivity, (err) => setError(agentError(err)));
  }, [agentId]);
  if (error)
    return (
      <p role="alert" className="text-destructive">
        {error}
      </p>
    );
  if (!activity) return <AgentActivitySkeleton />;
  return (
    <AgentActivity
      runs={activity.runs.map((r) => ({
        id: r.id,
        status: r.status,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        costUsd: r.cost_usd,
        testMode: r.test_mode,
        errorCode: r.error_code,
      }))}
      nextRunAt={activity.next_run_at}
      onOpen={(run) => goAgents({ page: "run", agentId, runId: run.id })}
    />
  );
}
