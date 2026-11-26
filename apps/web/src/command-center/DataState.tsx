import { Button, EmptyState } from "@legallabs/ui";
import { useState } from "react";
import { messageOf, when } from "../admin/load.js";
import { centerApi } from "./api.js";

/** "Data as of", and the way to ask for newer numbers (at most once an hour). */
export function Freshness({
  dataAsOf,
  message,
  onRefreshed,
}: {
  dataAsOf: string | null;
  message?: string | undefined;
  onRefreshed: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    setBusy(true);
    setError(null);
    centerApi
      .refresh()
      .then(onRefreshed, (e: unknown) => setError(messageOf(e)))
      .finally(() => setBusy(false));
  };
  const alert = error && (
    <p role="alert" className="text-destructive">
      {error}
    </p>
  );
  if (dataAsOf === null) {
    // The server words this as "First refresh at <ISO time>".
    const next = message?.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/)?.[0];
    return (
      <div>
        <EmptyState
          title="No usage data yet"
          description={`Nothing has been counted, so there are no numbers to show. ${
            next ? `The first refresh is at ${when(next)}.` : "Data refreshes every six hours."
          }`}
          action={{ label: "Refresh now", onClick: refresh }}
        />
        {alert}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-dense text-fg-muted">
        Data as of {when(dataAsOf)}. Refreshed every six hours.
      </p>
      <Button variant="quiet" size="sm" disabled={busy} onClick={refresh}>
        Refresh now
      </Button>
      {alert}
    </div>
  );
}
