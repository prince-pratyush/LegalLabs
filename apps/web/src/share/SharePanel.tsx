import {
  Button,
  type ExistingShare,
  PANEL_MIN,
  type RejectedShare,
  ShareForm,
  ShareFormSkeleton,
  SidePanel,
} from "@legallabs/ui";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Member, messageOf, type Share } from "../api.js";

const LINK_LABEL = "Anyone in the workspace with the link";

const labelOf = (share: Share, members: readonly Member[]) =>
  share.principal_type === "workspace"
    ? LINK_LABEL
    : (members.find((m) => m.id === share.principal_id)?.name ?? share.email ?? "Someone");

export function SharePanel({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const [width, setWidth] = useState(PANEL_MIN);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [rejected, setRejected] = useState<RejectedShare[]>([]);
  const [walled, setWalled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    Promise.all([api.members(), api.shares(threadId)]).then(
      ([people, current]) => {
        setMembers(people);
        setShares(current);
      },
      (err) => setLoadError(messageOf(err)),
    );
  }, [threadId]);

  useEffect(load, [load]);

  const share = async ({ memberIds, link }: { memberIds: string[]; link: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.share(threadId, { user_ids: memberIds, link });
      // Refusals are named, so nobody assumes a walled-off colleague can see it.
      setRejected(
        result.rejected.map((r) => {
          const member = members?.find((m) => m.id === r.id);
          return { name: member?.name ?? member?.email ?? "Someone", reason: r.reason };
        }),
      );
      setShares(await api.shares(threadId));
    } catch (err) {
      if (err instanceof ApiError && err.code === "WALL_MISMATCH") setWalled(true);
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (existing: ExistingShare) => {
    setError(null);
    try {
      await api.revoke(threadId, existing.id);
      setShares((list) => list?.filter((s) => s.id !== existing.id) ?? null);
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <SidePanel title="Share" onClose={onClose} width={width} onWidthChange={setWidth}>
      {loadError ? (
        <div role="alert" className="grid justify-items-start gap-2">
          <p className="text-ui">{loadError}</p>
          <Button size="sm" onClick={load}>
            Try again
          </Button>
        </div>
      ) : !members || !shares ? (
        <ShareFormSkeleton />
      ) : (
        <div className="grid gap-3">
          <p className="text-dense text-fg-muted">
            People you share with can read this thread, not add to it.
          </p>
          {error && (
            <p role="alert" className="text-dense text-destructive">
              {error}
            </p>
          )}
          <ShareForm
            members={members}
            shares={shares.map((s) => ({
              id: s.id,
              label: labelOf(s, members),
              kind: s.principal_type === "workspace" ? "link" : "user",
            }))}
            rejected={rejected}
            onShare={share}
            onRevoke={revoke}
            busy={busy}
            walled={walled}
          />
        </div>
      )}
    </SidePanel>
  );
}
