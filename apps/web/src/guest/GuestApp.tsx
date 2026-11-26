import { AppShell, Button, ConfirmDialog, EmptyState, toast } from "@legallabs/ui";
import { Lock, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { messageOf } from "../api.js";
import { useHash } from "../router.js";
import { formatDate } from "../vaults/shared.js";
import { type GuestSpaceSummary, type GuestSpaceView, guestApi } from "./api.js";

const TYPE_LABEL: Record<string, string> = {
  agent: "Agent",
  playbook: "Playbook",
  review_table: "Review table",
  scan: "Scan",
  thread: "Thread",
  vault: "Vault",
  workflow: "Workflow",
};
const ACCESS: Record<string, string> = {
  view: "Can view",
  run: "Can run",
  edit: "Can edit",
  full: "Full access",
};

export const guestSpaceId = (hash: string) => {
  const id = /^#\/guest\/spaces\/([^/?#]+)/.exec(hash)?.[1];
  return id ? decodeURIComponent(id) : null;
};
const toList = () => {
  window.location.hash = "#/guest";
};

/** Everything a signed-in guest gets: their Spaces, and nothing else of the workspace. */
export function GuestApp({ onSignOut }: { onSignOut: () => void }) {
  const id = guestSpaceId(useHash());
  const [spaces, setSpaces] = useState<GuestSpaceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    guestApi.spaces().then(setSpaces, (err) => setError(messageOf(err)));
  }, []);
  useEffect(load, [load]);
  const selected = spaces?.find((s) => s.space_id === id) ?? null;

  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Guest"
      commands={[
        { id: "spaces", kind: "action", group: "Go to", label: "Your Spaces", run: toList },
        { id: "sign-out", kind: "action", group: "Account", label: "Sign out", run: onSignOut },
      ]}
      sidebar={
        <div className="grid min-w-0 gap-2">
          <Button variant="quiet" size="sm" className="justify-start" onClick={toList}>
            Your Spaces
          </Button>
          <Button variant="quiet" size="sm" className="justify-start" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      }
    >
      <main id="main" className="flex min-w-0 flex-1 flex-col gap-4 overflow-auto p-6">
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {spaces === null ? (
          !error && (
            <p role="status" className="text-fg-muted">
              Loading your Spaces
            </p>
          )
        ) : id === null ? (
          <SpaceList spaces={spaces} />
        ) : selected ? (
          <GuestSpace key={selected.space_id} summary={selected} onChanged={load} />
        ) : (
          <EmptyState
            icon={Lock}
            title="That Space isn't available"
            description="Your access may have ended."
            action={{ label: "Your Spaces", onClick: toList }}
          />
        )}
      </main>
    </AppShell>
  );
}

function SpaceList({ spaces }: { spaces: GuestSpaceSummary[] }) {
  return (
    <>
      <h1 className="text-title font-semibold">Your Spaces</h1>
      {spaces.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No Spaces"
          description="Your access may have ended. Ask whoever invited you."
          action={{ label: "Reload", onClick: () => window.location.reload() }}
        />
      ) : (
        <ul aria-label="Your Spaces" className="grid gap-2">
          {spaces.map((s) => (
            <li key={s.space_id} className="rounded-md border border-control p-3">
              <a className="font-medium" href={`#/guest/spaces/${encodeURIComponent(s.space_id)}`}>
                {s.space_name}
              </a>
              <p className="text-dense text-fg-muted">
                {s.party_name} · access ends {formatDate(s.expires_at)}
                {s.connection_status === "resolved" ? "" : " · waiting for approval"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function GuestSpace({ summary, onChanged }: { summary: GuestSpaceSummary; onChanged: () => void }) {
  const [view, setView] = useState<GuestSpaceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  // The list can't say whether this side has already approved, so this screen remembers.
  const [approved, setApproved] = useState(false);
  const open = summary.connection_status === "resolved";

  useEffect(() => {
    // The server shows nothing until both sides approve, so nothing is asked for.
    if (open) guestApi.space(summary.space_id).then(setView, (err) => setError(messageOf(err)));
  }, [open, summary.space_id]);

  const decide = (work: Promise<unknown>, then: () => void = () => {}) =>
    work.then(
      () => {
        then();
        onChanged();
      },
      (err) => toast.error(messageOf(err)),
    );
  const workspace = view?.space.workspace_name;

  return (
    <>
      <p className="rounded-md border border-control bg-bg-sunken p-2 text-dense">
        <Lock aria-hidden className="mr-1 inline size-3" />
        External Space. People outside your organisation can see what is shared here.
      </p>
      <h1 className="text-title font-semibold">{summary.space_name}</h1>
      {summary.can_approve && !approved && (
        <section aria-label="Connection approval" className="grid gap-2">
          <p className="text-ui">
            You approve connections for {summary.party_name}. Nothing is shared until both sides
            approve.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => decide(guestApi.approve(summary.space_id), () => setApproved(true))}
            >
              Approve connection
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setRejecting(true)}>
              Reject
            </Button>
          </div>
        </section>
      )}
      {!open && (
        <p role="status" className="text-fg-muted">
          {approved
            ? "You've approved. Waiting for the other side."
            : "Waiting for both sides to approve the connection."}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {open && !view && !error && (
        <p role="status" className="text-fg-muted">
          Loading the Space
        </p>
      )}
      {view &&
        (view.resources.length === 0 ? (
          <p className="text-fg-muted">Nothing has been shared with {view.party.name} yet.</p>
        ) : (
          <ul aria-label="Shared with you" className="grid gap-2">
            {view.resources.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-control p-3"
              >
                <span className="flex-1">{r.name ?? "Name not available"}</span>
                <span className="text-dense text-fg-muted">
                  {TYPE_LABEL[r.resource_type] ?? r.resource_type} · {ACCESS[r.access] ?? r.access}
                </span>
              </li>
            ))}
          </ul>
        ))}
      <footer className="mt-auto text-caption text-fg-muted">
        Guest access{workspace ? ` · provided by ${workspace}` : ""}
      </footer>
      <ConfirmDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title="Reject this connection?"
        description={`${summary.party_name} is removed from the Space, with everyone invited from it.`}
        confirmLabel="Reject connection"
        destructive
        onConfirm={() => {
          setRejecting(false);
          void decide(guestApi.reject(summary.space_id), toList);
        }}
      />
    </>
  );
}
