import type { ApprovalConfig } from "@legallabs/contracts";
import { ApprovalSwitches, Button, ShareRequestQueue, Skeleton } from "@legallabs/ui";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api.js";
import { agentApi, agentError, type QueuedRequest } from "./api.js";

type Status = "pending" | "accepted" | "denied";

const forbidden = (err: unknown) => err instanceof ApiError && err.status === 403;

function AdminsOnly() {
  return <p className="text-dense text-fg-muted">Only agents admins can see this page.</p>;
}

/** Shares waiting for an agents admin; the requester hears the decision and any reason. */
export function RequestsPage() {
  const [status, setStatus] = useState<Status>("pending");
  const [rows, setRows] = useState<QueuedRequest[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [denied, setDenied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await agentApi.requests(status));
    } catch (err) {
      if (forbidden(err)) setDenied(true);
      else setError(agentError(err));
      setRows([]);
    }
  }, [status]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    api.members().then(
      (m) => setNames(new Map(m.map((x) => [x.id, x.name || x.email]))),
      () => undefined,
    );
  }, []);

  const decide = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(agentError(err));
    } finally {
      setBusyId(null);
    }
  };

  const who = (type: string, id: string) =>
    type === "workspace"
      ? "everyone in the workspace"
      : (names.get(id) ?? (type === "group" ? "a group" : "a person"));

  return (
    <div className="grid min-w-0 max-w-3xl content-start gap-4">
      <h1 className="text-title font-semibold">Share requests</h1>
      {denied ? (
        <AdminsOnly />
      ) : (
        <>
          <fieldset className="flex gap-1">
            <legend className="sr-only">Show</legend>
            {(["pending", "accepted", "denied"] as const).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={status === s ? "secondary" : "quiet"}
                aria-pressed={status === s}
                onClick={() => setStatus(s)}
              >
                {s === "pending" ? "Waiting" : s === "accepted" ? "Accepted" : "Denied"}
              </Button>
            ))}
          </fieldset>
          {rows === null ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <ShareRequestQueue
              requests={rows.map((r) => ({
                id: r.id,
                agentTitle: r.title ?? "An agent",
                principalLabel: who(r.principal_type, r.principal_id),
                level: r.level,
                requestedBy: names.get(r.requested_by) ?? "Someone",
                createdAt: r.created_at,
                status: r.status,
                reason: r.reason,
              }))}
              busyId={busyId}
              error={error}
              onAccept={(id) => decide(id, () => agentApi.accept(id))}
              onDeny={(id, reason) => decide(id, () => agentApi.deny(id, reason))}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Configurations → Sharing: which shares wait for approval. */
export function ApprovalsPage() {
  const [value, setValue] = useState<ApprovalConfig | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    agentApi.sharingConfig().then(setValue, (err) => {
      if (forbidden(err)) setDenied(true);
      else setError(agentError(err));
    });
  }, []);

  const change = async (next: ApprovalConfig) => {
    const before = value;
    setValue(next);
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      setValue(await agentApi.setSharingConfig(next));
      setSaved(true);
    } catch (err) {
      setValue(before);
      setError(agentError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-w-0 max-w-2xl content-start gap-4">
      <h1 className="text-title font-semibold">Sharing approvals</h1>
      {denied ? (
        <AdminsOnly />
      ) : value === null ? (
        error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : (
          <Skeleton className="h-32 w-full" />
        )
      ) : (
        <>
          <ApprovalSwitches value={value} busy={busy} error={error} onChange={change} />
          {saved && (
            <p role="status" className="text-dense text-fg-muted">
              Saved.
            </p>
          )}
        </>
      )}
    </div>
  );
}
