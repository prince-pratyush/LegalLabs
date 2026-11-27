import type { HorizonScan } from "@legallabs/contracts";
import { Button, EmptyState, Skeleton, StatusText } from "@legallabs/ui";
import { useCallback, useEffect, useState } from "react";
import { messageOf } from "../api.js";
import { type HorizonSettingsView, horizonApi } from "./api.js";
import { goHorizon, horizonHash } from "./route.js";

export function ScanHealth({ scan }: { scan: HorizonScan }) {
  if (scan.stopped) return <StatusText tone="warning">Stopped</StatusText>;
  return scan.health === "degraded" ? (
    <StatusText tone="warning">A source is failing</StatusText>
  ) : (
    <StatusText tone="verified">Running</StatusText>
  );
}

/** Your scans, and the workspace's switch for those who may use it. */
export function ListPage() {
  const [settings, setSettings] = useState<HorizonSettingsView | null>(null);
  const [scans, setScans] = useState<HorizonScan[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const found = await horizonApi.settings();
      setSettings(found);
      setScans(found.enabled ? await horizonApi.scans() : []);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const turn = async (enabled: boolean) => {
    try {
      await horizonApi.setEnabled(enabled);
      await load();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  if (error && !settings) return <p role="alert">{error}</p>;
  if (!settings || !scans) return <Skeleton className="h-40" />;
  return (
    <div className="grid content-start gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-title font-semibold">Horizon scanning</h1>
        <div className="flex gap-2">
          {settings.can_manage && (
            <Button variant="secondary" onClick={() => turn(!settings.enabled)}>
              {settings.enabled ? "Turn off for the workspace" : "Turn on for the workspace"}
            </Button>
          )}
          {settings.can_create && (
            <Button onClick={() => goHorizon({ page: "new" })}>New scan</Button>
          )}
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {!settings.enabled ? (
        <p>Horizon scanning is turned off for this workspace.</p>
      ) : scans.length === 0 ? (
        <EmptyState
          title="No scans yet"
          description="A scan watches public sources every hour and grades what is new."
          action={
            settings.can_create
              ? { label: "Create a scan", onClick: () => goHorizon({ page: "new" }) }
              : { label: "Check again", onClick: () => void load() }
          }
        />
      ) : (
        <ul className="grid gap-2">
          {scans.map((scan) => (
            <li
              key={scan.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
            >
              <a
                className="font-medium underline"
                href={horizonHash({ page: "scan", scanId: scan.id })}
              >
                {scan.name}
              </a>
              <span className="flex flex-wrap gap-3 text-caption text-fg-muted">
                <span>{`${scan.unread} unread`}</span>
                <span>{`${scan.high} high`}</span>
                <ScanHealth scan={scan} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
