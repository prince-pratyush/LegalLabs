import {
  AppShell,
  Button,
  EmptyState,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
} from "@legallabs/ui";
import { Lock, Users } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { FactsTab } from "../facts/FactsTab.js";
import { useHash } from "../vaults/route.js";
import { formatDate, messageOf } from "../vaults/shared.js";
import {
  type Activity,
  type DirectoryEntry,
  type Member,
  type Phase,
  type Space,
  spacesApi,
  type Task,
  type TaskStatus,
} from "./api.js";
import { GuestsTab } from "./GuestsTab.js";
import { ResourcesTab } from "./ResourcesTab.js";
import { parseSpaceRoute, type SpaceTab, spacesHash } from "./route.js";

const STATUSES: { value: TaskStatus; label: string }[] = [
  { value: "todo", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const focusId = (id: string) => () => document.getElementById(id)?.focus();
const toList = () => {
  window.location.hash = spacesHash();
};

const select = "h-8 rounded-md border border-control bg-bg-raised px-2 text-ui";

const assigneeLabel = (task: Task, names: Map<string, string>, agents: Map<string, string>) => {
  const a = task.assignee;
  if (!a) return "Unassigned";
  if (a.type === "assistant") return "Assistant";
  // An agent whose name the API withholds stays just "Agent".
  if (a.type === "agent") return agents.get(a.agent_id) ?? "Agent";
  return names.get(a.user_id) ?? "A teammate";
};

/** Spaces: a room for one piece of work, with its people, resources, phases and tasks. */
export function SpacesApp({ onLeave }: { onLeave: () => void }) {
  const route = parseSpaceRoute(useHash()) ?? { page: "list" as const };
  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Spaces"
      commands={[{ id: "threads", kind: "action", group: "Go to", label: "Threads", run: onLeave }]}
      sidebar={
        <div className="grid min-w-0 gap-2">
          <Button variant="quiet" size="sm" className="justify-start" onClick={onLeave}>
            Back to threads
          </Button>
          <Button
            variant="quiet"
            size="sm"
            className="justify-start"
            onClick={() => {
              window.location.hash = spacesHash();
            }}
          >
            All Spaces
          </Button>
        </div>
      }
    >
      <main id="main" className="flex min-w-0 flex-1 flex-col overflow-auto p-6">
        {route.page === "list" ? (
          <SpaceList />
        ) : (
          <SpacePage key={route.spaceId} spaceId={route.spaceId} tab={route.tab} />
        )}
      </main>
    </AppShell>
  );
}

function SpaceList() {
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [others, setOthers] = useState<DirectoryEntry[]>([]);
  const [name, setName] = useState("");
  const [external, setExternal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    spacesApi.list().then(setSpaces, (err) => setError(messageOf(err)));
    spacesApi.directory().then(setOthers, () => {});
  }, []);
  useEffect(load, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      const space = await spacesApi.create(name.trim(), external ? "external" : "internal");
      window.location.hash = spacesHash(space.id);
    } catch (err) {
      toast.error(messageOf(err));
    }
  };

  const mine = new Set((spaces ?? []).map((s) => s.id));
  const locked = others.filter((d) => d.locked && !mine.has(d.id));

  return (
    <>
      <h1 className="mb-4 text-title font-semibold">Spaces</h1>
      <form onSubmit={create} className="mb-6 flex max-w-lg flex-wrap items-end gap-2">
        <div className="grid flex-1 gap-1">
          <Label htmlFor="new-space">New Space</Label>
          <Input
            id="new-space"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name, e.g. Acme share purchase"
          />
        </div>
        <Button type="submit" disabled={!name.trim()}>
          Create
        </Button>
        <label className="flex w-full items-center gap-2 text-ui">
          <input
            type="checkbox"
            checked={external}
            onChange={(e) => setExternal(e.target.checked)}
          />
          External: a guest organisation can be invited
        </label>
      </form>
      {error && (
        <p role="alert" className="mb-4 text-destructive">
          {error}
        </p>
      )}
      {spaces === null ? (
        <p role="status" className="text-fg-muted">
          Loading Spaces
        </p>
      ) : spaces.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No Spaces yet"
          description="A Space gathers a matter's people, files and tasks in one place."
          action={{ label: "Name a Space", onClick: focusId("new-space") }}
        />
      ) : (
        <ul aria-label="Your Spaces" className="grid gap-2">
          {spaces.map((s) => (
            <li key={s.id} className="rounded-md border border-control p-3">
              <a className="font-medium" href={spacesHash(s.id)}>
                {s.name}
              </a>
              <p className="text-dense text-fg-muted">
                {s.matter ? `${s.matter.display} · ` : ""}
                {s.counts.members} members · {s.counts.open_tasks} open tasks
              </p>
            </li>
          ))}
        </ul>
      )}
      {locked.length > 0 && (
        <section className="mt-8" aria-labelledby="locked-heading">
          <h2
            id="locked-heading"
            className="mb-2 text-caption font-semibold text-fg-muted uppercase"
          >
            Ask to join
          </h2>
          <ul className="grid gap-2">
            {locked.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-3 rounded-md border border-control p-3"
              >
                <Lock aria-hidden className="size-4 text-fg-muted" />
                <span className="flex-1">{d.name}</span>
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() =>
                    spacesApi.requestAccess(d.id).then(
                      () => toast.success("Request sent to the Space's admins."),
                      (err) => toast.error(messageOf(err)),
                    )
                  }
                >
                  Request access
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function SpacePage({ spaceId, tab }: { spaceId: string; tab: SpaceTab }) {
  const [space, setSpace] = useState<Space | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    spacesApi.get(spaceId).then(setSpace, () => setMissing(true));
  }, [spaceId]);

  if (missing) {
    return (
      <EmptyState
        icon={Lock}
        title="That Space isn't available"
        description="It may have been deleted, or you may not have access."
        action={{ label: "Back to Spaces", onClick: toList }}
      />
    );
  }
  if (!space) {
    return (
      <p role="status" className="text-fg-muted">
        Loading the Space
      </p>
    );
  }
  const admin = space.my_role === "admin";
  return (
    <>
      {space.kind === "external" && (
        <p className="mb-3 rounded-md border border-control bg-bg-sunken p-2 text-dense">
          <Lock aria-hidden className="mr-1 inline size-3" />
          External Space. A guest organisation can see what you share with it.
        </p>
      )}
      <div className="mb-4">
        <h1 className="text-title font-semibold">{space.name}</h1>
        <p className="text-dense text-fg-muted">
          {space.matter ? `${space.matter.display} · ` : ""}You are{" "}
          {admin ? "an admin" : "a collaborator"}
        </p>
      </div>
      <Tabs
        value={tab}
        onValueChange={(next) => {
          window.location.hash = spacesHash(spaceId, next as SpaceTab);
        }}
      >
        <TabsList>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="resources">Resources</TabsTrigger>
          <TabsTrigger value="facts">Facts</TabsTrigger>
          {space.kind === "external" && <TabsTrigger value="guests">Guests</TabsTrigger>}
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="context">Context</TabsTrigger>
        </TabsList>
        <TabsContent value="tasks">
          <TasksTab space={space} />
        </TabsContent>
        <TabsContent value="members">
          <MembersTab spaceId={spaceId} />
        </TabsContent>
        <TabsContent value="resources">
          <ResourcesTab space={space} />
        </TabsContent>
        <TabsContent value="facts">
          <FactsTab spaceId={spaceId} />
        </TabsContent>
        {space.kind === "external" && (
          <TabsContent value="guests">
            <GuestsTab space={space} />
          </TabsContent>
        )}
        <TabsContent value="activity">
          <ActivityTab spaceId={spaceId} />
        </TabsContent>
        <TabsContent value="context">
          <ContextTab space={space} onSaved={setSpace} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function TasksTab({ space }: { space: Space }) {
  const admin = space.my_role === "admin";
  const [phases, setPhases] = useState<Phase[]>([]);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [agents, setAgents] = useState<Map<string, string>>(new Map());
  const [name, setName] = useState("");
  const [phaseId, setPhaseId] = useState("");
  const [gate, setGate] = useState(false);
  const [assign, setAssign] = useState("");
  const [phaseName, setPhaseName] = useState("");

  const load = useCallback(() => {
    spacesApi.phases(space.id).then(setPhases, (err) => toast.error(messageOf(err)));
    spacesApi.tasks(space.id).then(setTasks, (err) => toast.error(messageOf(err)));
  }, [space.id]);
  useEffect(load, [load]);
  useEffect(() => {
    let current = true;
    spacesApi.members(space.id).then(
      (list) => current && setMembers(list),
      (err) => toast.error(messageOf(err)),
    );
    // The agents shared into this Space are the ones a task here can go to.
    spacesApi.resources(space.id).then(
      (list) =>
        current &&
        setAgents(
          new Map(
            list.flatMap((r) =>
              r.resource_type === "agent" && r.name ? [[r.resource_id, r.name] as const] : [],
            ),
          ),
        ),
      (err) => toast.error(messageOf(err)),
    );
    return () => {
      current = false;
    };
  }, [space.id]);

  const names = new Map(
    members
      .filter((m) => m.principal_type === "user")
      .map((m) => [m.principal_id, m.label ?? "Member"]),
  );
  // Resolves to whether it worked, so a form clears only when its work succeeded.
  const act = (work: Promise<unknown>) =>
    work.then(
      () => {
        load();
        return true;
      },
      (err) => {
        toast.error(messageOf(err));
        return false;
      },
    );

  const addTask = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    const assignee =
      assign === "assistant"
        ? ({ type: "assistant" } as const)
        : assign.startsWith("agent:")
          ? ({ type: "agent", agent_id: assign.slice("agent:".length) } as const)
          : assign
            ? ({ type: "user", user_id: assign } as const)
            : undefined;
    const worked = await act(
      spacesApi.createTask(space.id, {
        name: name.trim(),
        phase_id: phaseId || null,
        gate,
        ...(assignee ? { assignee } : {}),
      }),
    );
    if (worked) {
      setName("");
      setGate(false);
    }
  };

  const columns: { phase: Phase | null; tasks: Task[] }[] = [
    ...phases.map((p) => ({ phase: p, tasks: (tasks ?? []).filter((t) => t.phase_id === p.id) })),
    { phase: null, tasks: (tasks ?? []).filter((t) => t.phase_id === null) },
  ].filter((c) => c.phase !== null || c.tasks.length > 0);

  return (
    <div className="grid gap-6 pt-4">
      <form onSubmit={addTask} className="flex flex-wrap items-end gap-2" aria-label="Create task">
        <div className="grid min-w-48 flex-1 gap-1">
          <Label htmlFor="task-name">Task</Label>
          <Input
            id="task-name"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="task-phase">Phase</Label>
          <select
            id="task-phase"
            className={select}
            value={phaseId}
            onChange={(e) => setPhaseId(e.target.value)}
          >
            <option value="">No phase</option>
            {phases.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="task-assignee">Assign to</Label>
          <select
            id="task-assignee"
            className={select}
            value={assign}
            onChange={(e) => setAssign(e.target.value)}
          >
            <option value="">Nobody</option>
            <option value="assistant">Assistant</option>
            {[...agents].map(([id, label]) => (
              <option key={id} value={`agent:${id}`}>
                Agent: {label}
              </option>
            ))}
            {[...names].map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {admin && (
          <label className="flex items-center gap-2 text-ui">
            <input type="checkbox" checked={gate} onChange={(e) => setGate(e.target.checked)} />
            Review gate
          </label>
        )}
        <Button type="submit" disabled={!name.trim()}>
          Add task
        </Button>
        <a className="text-ui underline" href={spacesApi.exportUrl(space.id)}>
          Export CSV
        </a>
      </form>

      {admin && (
        <form
          className="flex max-w-md items-end gap-2"
          aria-label="Add phase"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!phaseName.trim()) return;
            if (await act(spacesApi.createPhase(space.id, phaseName.trim()))) setPhaseName("");
          }}
        >
          <div className="grid flex-1 gap-1">
            <Label htmlFor="phase-name">New phase</Label>
            <Input
              id="phase-name"
              value={phaseName}
              maxLength={120}
              onChange={(e) => setPhaseName(e.target.value)}
            />
          </div>
          <Button type="submit" variant="quiet" disabled={!phaseName.trim()}>
            Add phase
          </Button>
        </form>
      )}

      {tasks === null ? (
        <p role="status" className="text-fg-muted">
          Loading tasks
        </p>
      ) : columns.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No tasks yet"
          description="Add a task above, or give one to the assistant."
          action={{ label: "Add a task", onClick: focusId("task-name") }}
        />
      ) : (
        columns.map(({ phase, tasks: list }) => (
          <section
            key={phase?.id ?? "none"}
            aria-label={phase ? `Phase: ${phase.name}` : "No phase"}
          >
            <h2 className="mb-2 flex items-center gap-2 text-caption font-semibold text-fg-muted uppercase">
              {phase?.name ?? "No phase"}
              {phase?.locked && (
                <span className="rounded bg-bg-sunken px-1.5 py-0.5 normal-case">
                  <Lock aria-hidden className="mr-1 inline size-3" />
                  Locked until the gate is approved
                </span>
              )}
              {phase?.locked && admin && (
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => act(spacesApi.unlockPhase(space.id, phase.id))}
                >
                  Unlock
                </Button>
              )}
            </h2>
            <ul className="grid gap-2">
              {list.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  admin={admin}
                  names={names}
                  agents={agents}
                  act={act}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function TaskRow({
  task,
  admin,
  names,
  agents,
  act,
}: {
  task: Task;
  admin: boolean;
  names: Map<string, string>;
  agents: Map<string, string>;
  act: (work: Promise<unknown>) => Promise<boolean>;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [why, setWhy] = useState("");
  return (
    <li className="rounded-md border border-control p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{task.name}</span>
        {task.gate && <span className="rounded bg-bg-sunken px-1.5 text-caption">Gate</span>}
        {task.awaiting_approval && (
          <span className="rounded bg-bg-sunken px-1.5 text-caption">Awaiting approval</span>
        )}
        {task.run && (
          <span className="rounded bg-bg-sunken px-1.5 text-caption">Run: {task.run.status}</span>
        )}
        <span className="ml-auto text-dense text-fg-muted">
          {assigneeLabel(task, names, agents)}
        </span>
        <label className="sr-only" htmlFor={`status-${task.id}`}>
          Status of {task.name}
        </label>
        <select
          id={`status-${task.id}`}
          className={select}
          value={task.status}
          onChange={(e) => act(spacesApi.setStatus(task.id, e.target.value as TaskStatus))}
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      {task.awaiting_approval && admin && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => act(spacesApi.approve(task.id))}>
            Approve
          </Button>
          {rejecting ? (
            <>
              <Input
                aria-label="Reason for rejecting"
                value={why}
                onChange={(e) => setWhy(e.target.value)}
                className="max-w-xs"
              />
              <Button
                size="sm"
                variant="quiet"
                disabled={!why.trim()}
                onClick={async () => {
                  if (await act(spacesApi.reject(task.id, why.trim()))) {
                    setRejecting(false);
                    setWhy("");
                  }
                }}
              >
                Send back
              </Button>
            </>
          ) : (
            <Button size="sm" variant="quiet" onClick={() => setRejecting(true)}>
              Reject
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** Loads once per `key`; the loader is read fresh each time but never re-triggers the load. */
function useLoaded<T>(load: () => Promise<T>, key: string) {
  const [data, setData] = useState<T | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names what the load is for
  useEffect(() => {
    let current = true;
    load().then(
      (value) => current && setData(value),
      (err) => toast.error(messageOf(err)),
    );
    return () => {
      current = false;
    };
  }, [key]);
  return data;
}

function MembersTab({ spaceId }: { spaceId: string }) {
  const members = useLoaded(() => spacesApi.members(spaceId), spaceId);
  if (!members) {
    return (
      <p role="status" className="pt-4 text-fg-muted">
        Loading members
      </p>
    );
  }
  return (
    <ul aria-label="Members" className="grid gap-2 pt-4">
      {members.map((m) => (
        <li key={m.id} className="flex items-center gap-3 rounded-md border border-control p-3">
          <span className="flex-1">{m.label ?? "A member"}</span>
          <span className="text-dense text-fg-muted">
            {m.principal_type === "group" ? "Group · " : ""}
            {m.role === "admin" ? "Admin" : "Collaborator"}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ActivityTab({ spaceId }: { spaceId: string }) {
  const items = useLoaded<Activity[]>(() => spacesApi.activity(spaceId), spaceId);
  if (!items) {
    return (
      <p role="status" className="pt-4 text-fg-muted">
        Loading activity
      </p>
    );
  }
  return (
    <ol aria-label="Activity" className="grid gap-1 pt-4">
      {items.map((a) => (
        <li key={a.id} className="text-ui">
          <span className="font-medium">{a.actor_name ?? a.actor_type}</span> · {a.type} ·{" "}
          <span className="text-fg-muted">{formatDate(a.at)}</span>
        </li>
      ))}
    </ol>
  );
}

function ContextTab({ space, onSaved }: { space: Space; onSaved: (s: Space) => void }) {
  const admin = space.my_role === "admin";
  const [summary, setSummary] = useState(space.context.summary ?? "");
  const [instructions, setInstructions] = useState(space.context.standing_instructions ?? "");

  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const next = await spacesApi.setContext(space.id, {
        ...(summary ? { summary } : {}),
        parties: space.context.parties,
        key_dates: space.context.key_dates,
        ...(instructions ? { standing_instructions: instructions } : {}),
      });
      onSaved(next);
      toast.success("Context saved.");
    } catch (err) {
      toast.error(messageOf(err));
    }
  };

  return (
    <form onSubmit={save} className="grid max-w-2xl gap-4 pt-4" aria-label="Space context">
      <p className="text-dense text-fg-muted">
        Everyone in the Space sees this, and it goes into every run started here.
      </p>
      <div className="grid gap-1">
        <Label htmlFor="ctx-summary">Summary</Label>
        <Textarea
          id="ctx-summary"
          value={summary}
          maxLength={2000}
          disabled={!admin}
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="ctx-instructions">Standing instructions</Label>
        <Textarea
          id="ctx-instructions"
          value={instructions}
          maxLength={10000}
          disabled={!admin}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </div>
      {space.context.parties.length > 0 && (
        <ul aria-label="Parties" className="text-ui">
          {space.context.parties.map((p) => (
            <li key={p.name}>
              {p.name} — {p.role}
            </li>
          ))}
        </ul>
      )}
      {admin && (
        <div>
          <Button type="submit">Save context</Button>
        </div>
      )}
    </form>
  );
}
