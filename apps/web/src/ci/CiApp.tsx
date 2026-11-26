import { AppShell, Button } from "@legallabs/ui";
import { useHash } from "../router.js";
import { AgentList } from "./AgentList.js";
import { AgentPage } from "./AgentPage.js";
import { CiReviewPage } from "./CiReviewPage.js";
import { QueuePage } from "./QueuePage.js";
import { type CiRoute, goCi, parseCiRoute } from "./route.js";
import { SubmitPage } from "./SubmitPage.js";

const LINKS: { label: string; route: CiRoute; pages: CiRoute["page"][] }[] = [
  { label: "Contract queue", route: { page: "queue" }, pages: ["queue", "review"] },
  { label: "Review agents", route: { page: "agents" }, pages: ["agents", "agent", "new-agent"] },
  { label: "Submit a contract", route: { page: "submit", agentId: null }, pages: ["submit"] },
];

/** The contract queue and the review agents that fill it, chosen by the address. */
export function CiApp({ onLeave }: { onLeave: () => void }) {
  const route = parseCiRoute(useHash());
  if (!route) return null;
  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Contracts"
      commands={[
        ...LINKS.map((link) => ({
          id: `ci-${link.route.page}`,
          kind: "action" as const,
          group: "Contracts",
          label: link.label,
          run: () => goCi(link.route),
        })),
        { id: "threads", kind: "action", group: "Go to", label: "Threads", run: onLeave },
      ]}
      sidebar={
        <div className="grid min-w-0 gap-2">
          <Button variant="quiet" size="sm" className="justify-start" onClick={onLeave}>
            Back to threads
          </Button>
          {LINKS.map((link) => (
            <Button
              key={link.label}
              variant="quiet"
              size="sm"
              className="justify-start aria-[current=page]:tint-selected"
              aria-current={link.pages.includes(route.page) ? "page" : undefined}
              onClick={() => goCi(link.route)}
            >
              {link.label}
            </Button>
          ))}
        </div>
      }
    >
      <div className="grid min-w-0 content-start p-6">
        {route.page === "queue" ? (
          <QueuePage />
        ) : route.page === "review" ? (
          <CiReviewPage key={route.reviewId} reviewId={route.reviewId} />
        ) : route.page === "agents" ? (
          <AgentList />
        ) : route.page === "submit" ? (
          <SubmitPage key={route.agentId} agentId={route.agentId} />
        ) : (
          <AgentPage
            key={route.page === "agent" ? route.agentId : "new"}
            agentId={route.page === "agent" ? route.agentId : null}
          />
        )}
      </div>
    </AppShell>
  );
}
