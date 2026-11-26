import type { CiAgent } from "@legallabs/contracts";
import { Button, EmptyState, Skeleton } from "@legallabs/ui";
import { useEffect, useState } from "react";
import { messageOf } from "../api.js";
import { ciApi } from "./api.js";
import { ciHash, goCi } from "./route.js";
import { AgentStatusText } from "./shared.js";

/** The caller's own review agents. */
export function AgentList() {
  const [agents, setAgents] = useState<CiAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    ciApi.agents().then(setAgents, (err) => setError(messageOf(err)));
  }, []);
  const create = () => goCi({ page: "new-agent" });

  return (
    <div className="grid max-w-2xl content-start gap-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-title font-semibold">Review agents</h1>
        {agents && agents.length > 0 && <Button onClick={create}>New review agent</Button>}
      </header>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : agents === null ? (
        <Skeleton className="h-24" />
      ) : agents.length === 0 ? (
        <EmptyState
          title="No review agents yet"
          description="An agent reviews contracts against a playbook and says who should look."
          action={{ label: "New review agent", onClick: create }}
        />
      ) : (
        <ul className="grid divide-y divide-border rounded-md border border-border">
          {agents.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3 py-2">
              <a className="underline" href={ciHash({ page: "agent", agentId: a.id })}>
                {a.name}
              </a>
              <span className="text-fg-muted">{a.contract_type}</span>
              <span className="ml-auto">
                <AgentStatusText status={a.status} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
