import { AppShell, Button } from "@legallabs/ui";
import { Bot, Inbox, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useHash } from "../vaults/route.js";
import { ApprovalsPage, RequestsPage } from "./AdminSharing.js";
import { AgentList } from "./AgentList.js";
import { AgentPage } from "./AgentPage.js";
import { type Agent, agentApi } from "./api.js";
import { BuildPage } from "./BuildPage.js";
import { RunPage } from "./RunPage.js";
import { goAgents, parseAgentRoute } from "./route.js";
import { TestPage } from "./TestPage.js";

/** The Agents pages and the share approvals, chosen by the address. */
export function AgentsApp({ onLeave }: { onLeave: () => void }) {
  const route = parseAgentRoute(useHash()) ?? { page: "list" };
  const [me, setMe] = useState<string | null>(null);
  const [recent, setRecent] = useState<Agent[]>([]);
  useEffect(() => {
    api.session().then(
      (s) => setMe(s.user_id),
      () => undefined,
    );
    agentApi.list().then(setRecent, () => undefined);
  }, []);
  const current = (match: boolean) => (match ? ("page" as const) : undefined);

  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Agents"
      commands={[
        {
          id: "agents",
          kind: "action",
          group: "Agents",
          label: "All agents",
          run: () => goAgents({ page: "list" }),
        },
        ...recent.slice(0, 20).map((a) => ({
          id: `agent-${a.id}`,
          kind: "object" as const,
          group: "Agents",
          label: a.title,
          run: () => goAgents({ page: "agent", agentId: a.id, tab: "instructions" }),
        })),
        {
          id: "requests",
          kind: "action",
          group: "Admin",
          label: "Share requests",
          run: () => goAgents({ page: "requests" }),
        },
        { id: "threads", kind: "action", group: "Go to", label: "Threads", run: onLeave },
      ]}
      sidebar={
        <div className="grid min-w-0 gap-1">
          <Button variant="quiet" size="sm" className="justify-start" onClick={onLeave}>
            Back to threads
          </Button>
          <Button
            variant="quiet"
            size="sm"
            className="justify-start aria-[current=page]:tint-selected"
            aria-current={current(route.page === "list")}
            onClick={() => goAgents({ page: "list" })}
          >
            <Bot aria-hidden />
            All agents
          </Button>
          <Button
            variant="quiet"
            size="sm"
            className="justify-start aria-[current=page]:tint-selected"
            aria-current={current(route.page === "requests")}
            onClick={() => goAgents({ page: "requests" })}
          >
            <Inbox aria-hidden />
            Share requests
          </Button>
          <Button
            variant="quiet"
            size="sm"
            className="justify-start aria-[current=page]:tint-selected"
            aria-current={current(route.page === "approvals")}
            onClick={() => goAgents({ page: "approvals" })}
          >
            <ShieldCheck aria-hidden />
            Sharing approvals
          </Button>
        </div>
      }
    >
      <main id="main" className="flex min-w-0 flex-1 flex-col overflow-auto p-4 md:p-6">
        {route.page === "list" ? (
          <AgentList me={me} />
        ) : route.page === "agent" ? (
          <AgentPage key={route.agentId} agentId={route.agentId} tab={route.tab} />
        ) : route.page === "build" ? (
          <BuildPage key={route.agentId} agentId={route.agentId} />
        ) : route.page === "test" ? (
          <TestPage key={route.agentId} agentId={route.agentId} version={route.version} />
        ) : route.page === "run" ? (
          <RunPage key={route.runId} agentId={route.agentId} runId={route.runId} />
        ) : route.page === "requests" ? (
          <RequestsPage />
        ) : (
          <ApprovalsPage />
        )}
      </main>
    </AppShell>
  );
}
