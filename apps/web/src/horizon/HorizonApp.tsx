import type { HorizonScan } from "@legallabs/contracts";
import { AppShell, Button, Skeleton } from "@legallabs/ui";
import { useEffect, useState } from "react";
import { messageOf } from "../api.js";
import { useHash } from "../router.js";
import { horizonApi } from "./api.js";
import { ListPage } from "./ListPage.js";
import { goHorizon, parseHorizonRoute } from "./route.js";
import { ScanForm } from "./ScanForm.js";
import { ScanPage } from "./ScanPage.js";

function EditPage({ scanId }: { scanId: string }) {
  const [scan, setScan] = useState<HorizonScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    horizonApi.scan(scanId).then(setScan, (err) => setError(messageOf(err)));
  }, [scanId]);
  if (error) return <p role="alert">{error}</p>;
  return scan ? <ScanForm scan={scan} /> : <Skeleton className="h-40" />;
}

/** Horizon scanning, chosen by the address. */
export function HorizonApp({ onLeave }: { onLeave: () => void }) {
  const route = parseHorizonRoute(useHash());
  if (!route) return null;
  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Horizon scanning"
      commands={[
        {
          id: "horizon-list",
          kind: "action",
          group: "Horizon scanning",
          label: "Your scans",
          run: () => goHorizon({ page: "list" }),
        },
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
            onClick={() => goHorizon({ page: "list" })}
          >
            Your scans
          </Button>
        </div>
      }
    >
      <div className="grid min-w-0 content-start p-6">
        {route.page === "list" ? (
          <ListPage />
        ) : route.page === "new" ? (
          <ScanForm />
        ) : route.page === "edit" ? (
          <EditPage key={route.scanId} scanId={route.scanId} />
        ) : (
          <ScanPage key={route.scanId} scanId={route.scanId} />
        )}
      </div>
    </AppShell>
  );
}
