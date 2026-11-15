import type { PlaybookSummary } from "@legallabs/contracts";
import { AppShell, Button, Skeleton } from "@legallabs/ui";
import { BookCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useHash } from "../vaults/route.js";
import { playbookApi } from "./api.js";
import { PlaybookList } from "./PlaybookList.js";
import { PlaybookPage } from "./PlaybookPage.js";
import { goPlaybooks, parsePlaybookRoute } from "./route.js";

/** The playbook list and builder, chosen by the address. */
export function PlaybooksApp({ onLeave }: { onLeave: () => void }) {
  const route = parsePlaybookRoute(useHash()) ?? { page: "list" };
  const [recent, setRecent] = useState<PlaybookSummary[] | null>(null);
  const refresh = useCallback(() => {
    playbookApi.list().then(setRecent, () => setRecent([]));
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Playbooks"
      commands={[
        {
          id: "playbooks",
          kind: "action",
          group: "Playbooks",
          label: "All playbooks",
          run: () => goPlaybooks({ page: "list" }),
        },
        ...(recent ?? []).map((p) => ({
          id: `playbook-${p.id}`,
          kind: "object" as const,
          group: "Playbooks",
          label: p.name,
          run: () => goPlaybooks({ page: "playbook", playbookId: p.id, version: null }),
        })),
        { id: "threads", kind: "action", group: "Go to", label: "Threads", run: onLeave },
      ]}
      sidebar={
        <div className="grid min-w-0 gap-2">
          <Button variant="quiet" size="sm" className="justify-start" onClick={onLeave}>
            Back to threads
          </Button>
          <Button
            variant="quiet"
            size="sm"
            className="justify-start aria-[current=page]:tint-selected"
            aria-current={route.page === "list" ? "page" : undefined}
            onClick={() => goPlaybooks({ page: "list" })}
          >
            All playbooks
          </Button>
          <h2 className="text-caption font-semibold text-fg-muted uppercase">Recent</h2>
          {recent === null ? (
            <div aria-busy="true" className="grid gap-2">
              <Skeleton className="h-5" />
              <Skeleton className="h-5" />
            </div>
          ) : (
            <ul className="grid gap-0.5">
              {recent.slice(0, 10).map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    aria-current={
                      route.page === "playbook" && route.playbookId === p.id ? "page" : undefined
                    }
                    onClick={() =>
                      goPlaybooks({ page: "playbook", playbookId: p.id, version: null })
                    }
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-ui hover:tint-hover aria-[current=page]:bg-bg-raised"
                  >
                    <BookCheck aria-hidden className="size-4 shrink-0 text-fg-muted" />
                    <span className="truncate">{p.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      }
    >
      <main id="main" className="flex min-w-0 flex-1 flex-col overflow-auto p-6">
        {route.page === "list" ? (
          <PlaybookList onChanged={refresh} />
        ) : (
          <PlaybookPage
            key={route.playbookId}
            playbookId={route.playbookId}
            version={route.version}
            onChanged={refresh}
          />
        )}
      </main>
    </AppShell>
  );
}
