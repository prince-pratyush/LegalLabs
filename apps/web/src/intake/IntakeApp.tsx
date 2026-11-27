import { AppShell, Button } from "@legallabs/ui";
import { useHash } from "../router.js";
import { QueuePage } from "./QueuePage.js";
import { RequestPage } from "./RequestPage.js";
import { goIntake, type IntakeRoute, parseIntakeRoute } from "./route.js";
import { TypePage } from "./TypePage.js";
import { TypesPage } from "./TypesPage.js";

const LINKS: { label: string; route: IntakeRoute; pages: IntakeRoute["page"][] }[] = [
  { label: "Triage queue", route: { page: "queue" }, pages: ["queue", "request"] },
  { label: "Request types", route: { page: "types" }, pages: ["types", "type", "new-type"] },
];

/** The intake queue and the request types behind it, chosen by the address. */
export function IntakeApp({ onLeave }: { onLeave: () => void }) {
  const route = parseIntakeRoute(useHash());
  if (!route) return null;
  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Intake"
      commands={[
        ...LINKS.map((link) => ({
          id: `intake-${link.route.page}`,
          kind: "action" as const,
          group: "Intake",
          label: link.label,
          run: () => goIntake(link.route),
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
              onClick={() => goIntake(link.route)}
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
        ) : route.page === "request" ? (
          <RequestPage key={route.requestId} requestId={route.requestId} />
        ) : route.page === "types" ? (
          <TypesPage />
        ) : (
          <TypePage
            key={route.page === "type" ? route.typeId : "new"}
            typeId={route.page === "type" ? route.typeId : null}
          />
        )}
      </div>
    </AppShell>
  );
}
