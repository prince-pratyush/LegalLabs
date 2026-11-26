import { Button, EmptyState, Input, Label, toast } from "@legallabs/ui";
import { Bot, Users } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { agentApi } from "../agents/api.js";
import { messageOf } from "../vaults/shared.js";
import { type Party, type Resource, type ShareRequest, type Space, spacesApi } from "./api.js";

const select = "h-8 rounded-md border border-control bg-bg-raised px-2 text-ui";

/** An agent is never shared at Full into a Space. */
const AGENT_LEVELS = [
  { value: "run", label: "Can run" },
  { value: "view", label: "Can view" },
  { value: "edit", label: "Can edit" },
];
const ACCESS: Record<string, string> = {
  view: "Can view",
  run: "Can run",
  edit: "Can edit",
  full: "Full access",
};
const TYPE: Record<string, string> = {
  agent: "Agent",
  playbook: "Playbook",
  review_table: "Review table",
  scan: "Scan",
  thread: "Thread",
  vault: "Vault",
  workflow: "Workflow",
};

type Act = (work: Promise<unknown>) => Promise<boolean>;

/** What is shared in the Space, sharing an agent into it, and the shares waiting for an admin. */
export function ResourcesTab({ space }: { space: Space }) {
  const admin = space.my_role === "admin";
  const [resources, setResources] = useState<Resource[] | null>(null);
  const [requests, setRequests] = useState<ShareRequest[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const failed = (err: unknown) => setError(messageOf(err));
    spacesApi.resources(space.id).then(setResources, failed);
    // Only a Space admin may read what is waiting.
    if (admin) spacesApi.shareRequests(space.id).then(setRequests, failed);
  }, [space.id, admin]);
  useEffect(load, [load]);

  const act: Act = (work) =>
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

  return (
    <div className="grid max-w-2xl gap-6 pt-4">
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <ShareAgent space={space} onShared={load} />
      {requests.length > 0 && (
        <section aria-labelledby="pending-heading" className="grid gap-2">
          <h2 id="pending-heading" className="text-section font-semibold">
            Waiting for your approval
          </h2>
          <ul className="grid gap-2">
            {requests.map((r) => (
              <PendingRow key={r.id} request={r} spaceId={space.id} act={act} />
            ))}
          </ul>
        </section>
      )}
      {resources === null ? (
        !error && (
          <p role="status" className="text-fg-muted">
            Loading resources
          </p>
        )
      ) : resources.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Nothing shared here yet"
          description="Share one of your agents into this Space above."
          action={{
            label: "Choose an agent",
            onClick: () => document.getElementById("share-agent")?.focus(),
          }}
        />
      ) : (
        <ul aria-label="Resources" className="grid gap-2">
          {resources.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-control p-3"
            >
              <span className="flex-1">{r.name ?? "A resource you can't open"}</span>
              <span className="text-dense text-fg-muted">
                {TYPE[r.resource_type] ?? r.resource_type} · {ACCESS[r.access] ?? r.access}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PendingRow({
  request,
  spaceId,
  act,
}: {
  request: ShareRequest;
  spaceId: string;
  act: Act;
}) {
  const [declining, setDeclining] = useState(false);
  const [why, setWhy] = useState("");
  const outside = Object.values(request.per_party ?? {}).includes("run");
  return (
    <li className="grid gap-2 rounded-md border border-control p-3">
      <p className="text-ui">
        <Bot aria-hidden className="mr-1 inline size-4" />
        {request.requester_name} asks to share <strong>{request.name}</strong> at{" "}
        {ACCESS[request.access] ?? request.access}.
        {outside ? " The guest organisation could run it." : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          aria-label={`Accept sharing ${request.name}`}
          onClick={() => act(spacesApi.decideShare(spaceId, request.id, { decision: "accept" }))}
        >
          Accept
        </Button>
        {declining ? (
          <>
            <Input
              aria-label="Reason for declining"
              value={why}
              maxLength={1000}
              onChange={(e) => setWhy(e.target.value)}
              className="max-w-xs"
            />
            <Button
              size="sm"
              variant="quiet"
              disabled={!why.trim()}
              onClick={() =>
                act(
                  spacesApi.decideShare(spaceId, request.id, {
                    decision: "deny",
                    reason: why.trim(),
                  }),
                )
              }
            >
              Send decline
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="quiet"
            aria-label={`Decline sharing ${request.name}`}
            onClick={() => setDeclining(true)}
          >
            Decline
          </Button>
        )}
      </div>
    </li>
  );
}

function ShareAgent({ space, onShared }: { space: Space; onShared: () => void }) {
  const external = space.kind === "external";
  const [agents, setAgents] = useState<{ id: string; title: string }[]>([]);
  const [party, setParty] = useState<Party | null>(null);
  const [agentId, setAgentId] = useState("");
  const [level, setLevel] = useState("run");
  const [guests, setGuests] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Sharing takes Full access in one's own right; the server checks it again.
    agentApi.list().then(
      (all) => setAgents(all.filter((a) => a.my_access === "full")),
      () => undefined,
    );
    if (external) {
      spacesApi.parties(space.id).then(
        (list) => setParty(list.find((p) => p.connection.status === "resolved") ?? null),
        () => undefined,
      );
    }
  }, [space.id, external]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!agentId) return;
    setNotice(null);
    setError(null);
    try {
      const pending = await spacesApi.shareAgent(space.id, {
        resource_id: agentId,
        access: level,
        ...(party && guests ? { per_party: { [party.id]: "run" } } : {}),
      });
      setNotice(pending ? "Sent to the Space's admins. It is shared once one accepts." : "Shared.");
      setAgentId("");
      setGuests(false);
      onShared();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <form onSubmit={submit} aria-label="Share an agent" className="grid gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-48 flex-1 gap-1">
          <Label htmlFor="share-agent">Agent</Label>
          <select
            id="share-agent"
            className={select}
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            <option value="">
              {agents.length === 0 ? "You have no agent you can share" : "Choose an agent"}
            </option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="share-level">Level</Label>
          <select
            id="share-level"
            className={select}
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          >
            {AGENT_LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={!agentId}>
          Share agent
        </Button>
      </div>
      {party && (
        <label className="flex items-center gap-2 text-ui">
          <input type="checkbox" checked={guests} onChange={(e) => setGuests(e.target.checked)} />
          Let {party.name} run it. Guests see its title only.
        </label>
      )}
      {notice && (
        <p role="status" className="text-ui">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
