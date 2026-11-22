import { type FormEvent, useId, useState } from "react";
import { Button } from "../button.js";
import { Checkbox } from "../checkbox.js";
import { Label, Textarea } from "../field.js";
import { StatusText } from "../status.js";
import { ACCESS_LABEL, type AccessLevel, formatWhen } from "./types.js";

export type ShareRequestRow = {
  id: string;
  agentTitle: string;
  principalLabel: string;
  level: AccessLevel;
  requestedBy: string;
  createdAt: string;
  status: "pending" | "accepted" | "denied";
  reason: string | null;
};

/** The admin queue: each share waiting for a decision, with Accept or Deny and a reason. */
export function ShareRequestQueue({
  requests,
  busyId,
  error,
  onAccept,
  onDeny,
}: {
  requests: readonly ShareRequestRow[];
  busyId?: string | null;
  error?: string | null;
  onAccept: (id: string) => void;
  onDeny: (id: string, reason: string) => void;
}) {
  const [denying, setDenying] = useState<string | null>(null);
  if (requests.length === 0)
    return <p className="text-dense text-fg-muted">No requests are waiting.</p>;
  return (
    <div className="grid gap-2">
      {error && (
        <p role="alert" className="text-dense text-destructive">
          {error}
        </p>
      )}
      <ul aria-label="Share requests" className="grid gap-2">
        {requests.map((r) => (
          <li key={r.id} className="grid gap-2 rounded-md border border-border p-3">
            <p className="text-ui">
              <span className="font-semibold">{r.requestedBy}</span> wants to share{" "}
              <span className="font-semibold">{r.agentTitle}</span> with{" "}
              <span className="font-semibold">{r.principalLabel}</span> ({ACCESS_LABEL[r.level]}).
            </p>
            <p className="text-caption text-fg-muted">Asked {formatWhen(r.createdAt)}</p>
            {r.status === "pending" ? (
              denying === r.id ? (
                <DenyForm
                  busy={busyId === r.id}
                  onDeny={(reason) => onDeny(r.id, reason)}
                  onCancel={() => setDenying(null)}
                />
              ) : (
                <div className="flex gap-2">
                  <Button size="sm" disabled={busyId === r.id} onClick={() => onAccept(r.id)}>
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyId === r.id}
                    onClick={() => setDenying(r.id)}
                  >
                    Deny
                  </Button>
                </div>
              )
            ) : r.status === "accepted" ? (
              <StatusText tone="verified" className="text-dense">
                Accepted
              </StatusText>
            ) : (
              <StatusText tone="failed" className="text-dense">
                Denied{r.reason ? `: ${r.reason}` : ""}
              </StatusText>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DenyForm({
  busy,
  onDeny,
  onCancel,
}: {
  busy: boolean;
  onDeny: (reason: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onDeny(reason.trim());
  };
  return (
    <form onSubmit={submit} className="grid gap-2">
      <Label htmlFor={id} className="text-dense">
        Reason (the requester sees this)
      </Label>
      <Textarea
        id={id}
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
        className="min-h-12"
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={busy}>
          Deny request
        </Button>
        <Button size="sm" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export type ApprovalValue = { individual: boolean; group: boolean; workspace: boolean };

const SWITCHES: { key: keyof ApprovalValue; label: string; hint: string }[] = [
  {
    key: "individual",
    label: "Sharing with a person",
    hint: "Off by default: people can share with a colleague at once.",
  },
  { key: "group", label: "Sharing with a group", hint: "Off by default." },
  {
    key: "workspace",
    label: "Sharing with the whole workspace",
    hint: "On by default, so a workspace-wide agent is checked first.",
  },
];

/** Which shares wait for an agents admin. Admins' own shares never wait. */
export function ApprovalSwitches({
  value,
  busy = false,
  error,
  onChange,
}: {
  value: ApprovalValue;
  busy?: boolean;
  error?: string | null;
  onChange: (next: ApprovalValue) => void;
}) {
  const id = useId();
  return (
    <fieldset className="grid gap-3" aria-describedby={`${id}-note`}>
      <legend className="mb-1 text-section font-semibold">Require approval for</legend>
      <p id={`${id}-note`} className="text-dense text-fg-muted">
        Shares into a Space follow the Space's own rules and aren't set here.
      </p>
      {SWITCHES.map((s) => (
        <div key={s.key} className="flex items-start gap-2">
          <Checkbox
            id={`${id}-${s.key}`}
            aria-describedby={`${id}-${s.key}-hint`}
            checked={value[s.key]}
            disabled={busy}
            onCheckedChange={(on) => onChange({ ...value, [s.key]: on === true })}
          />
          <div className="grid">
            <Label htmlFor={`${id}-${s.key}`}>{s.label}</Label>
            <span id={`${id}-${s.key}-hint`} className="text-caption text-fg-muted">
              {s.hint}
            </span>
          </div>
        </div>
      ))}
      {error && (
        <p role="alert" className="text-dense text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
