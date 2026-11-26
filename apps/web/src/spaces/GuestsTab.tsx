import { Button, ConfirmDialog, Input, Label, toast } from "@legallabs/ui";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useStepUp } from "../retention/StepUp.js";
import { formatDate, messageOf } from "../vaults/shared.js";
import { type Guest, type Party, type Resource, type Space, spacesApi } from "./api.js";

const select = "h-8 rounded-md border border-control bg-bg-raised px-2 text-ui";

const STATUS: Record<Party["connection"]["status"], string> = {
  action_required: "Waiting for approval from both sides",
  in_progress: "Waiting for one more approval",
  resolved: "Connected",
  rejected: "Rejected",
};
const LEVEL: Record<string, string> = {
  none: "No access",
  run: "Can run",
  view: "Can view",
  edit: "Can edit",
};
const RUNNABLE = ["workflow", "playbook", "scan"];

/** What a guest organisation may be given on a resource. An agent is Run or nothing. */
export const partyLevels = (resourceType: string) =>
  resourceType === "agent"
    ? ["none", "run"]
    : RUNNABLE.includes(resourceType)
      ? ["none", "view", "run", "edit"]
      : ["none", "view", "edit"];

type Act = (work: Promise<unknown>) => Promise<boolean>;
interface Confirm {
  title: string;
  description: string;
  label: string;
  run: () => Promise<unknown>;
}

/** The guest organisation of an external Space: its connection, people and access. */
export function GuestsTab({ space }: { space: Space }) {
  const admin = space.my_role === "admin";
  const [parties, setParties] = useState<Party[] | null>(null);
  const [guests, setGuests] = useState<Guest[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const load = useCallback(() => {
    const failed = (err: unknown) => setError(messageOf(err));
    spacesApi.parties(space.id).then(setParties, failed);
    // Only admins may read these; asking otherwise would only be refused.
    if (admin) {
      spacesApi.guests(space.id).then(setGuests, failed);
      spacesApi.resources(space.id).then(setResources, failed);
    }
  }, [space.id, admin]);
  useEffect(load, [load]);

  const act: Act = (work) =>
    work.then(
      () => {
        setError(null);
        load();
        return true;
      },
      (err) => {
        toast.error(messageOf(err));
        return false;
      },
    );

  if (!parties) {
    return error ? (
      <p role="alert" className="pt-4 text-destructive">
        {error}
      </p>
    ) : (
      <p role="status" className="pt-4 text-fg-muted">
        Loading guests
      </p>
    );
  }
  const party = parties[0] ?? null;

  return (
    <div className="grid max-w-2xl gap-6 pt-4">
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {!party ? (
        admin ? (
          <PartyForm
            spaceId={space.id}
            onAdded={() => {
              setError(null);
              load();
            }}
          />
        ) : (
          <p className="text-fg-muted">No guest organisation yet.</p>
        )
      ) : (
        <>
          <section aria-label="Guest organisation" className="grid gap-2">
            <h2 className="text-section font-semibold">{party.name}</h2>
            <p className="text-dense text-fg-muted">
              {party.domain}
              {party.connection_admin_emails.length > 0 &&
                ` · approvers: ${party.connection_admin_emails.join(", ")}`}
            </p>
            <p className="text-ui">
              {STATUS[party.connection.status]}
              {party.connection.approvals.length > 0 &&
                party.connection.status !== "resolved" &&
                ` · approved by ${party.connection.approvals
                  .map((a) => (a.side === "internal" ? "your side" : party.name))
                  .join(" and ")}`}
            </p>
            <div className="flex flex-wrap gap-2">
              {party.connection.status !== "resolved" &&
                !party.connection.approvals.some((a) => a.side === "internal") && (
                  <>
                    <Button
                      size="sm"
                      onClick={() => act(spacesApi.approveParty(space.id, party.id))}
                    >
                      Approve connection
                    </Button>
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() =>
                        setConfirm({
                          title: `Reject ${party.name}?`,
                          description:
                            "The organisation and its guests are removed from the Space.",
                          label: "Reject connection",
                          run: () => spacesApi.rejectParty(space.id, party.id),
                        })
                      }
                    >
                      Reject
                    </Button>
                  </>
                )}
              {admin && (
                <Button
                  size="sm"
                  variant="quiet"
                  className="text-destructive"
                  onClick={() =>
                    setConfirm({
                      title: `Remove ${party.name}?`,
                      description: "Its guests lose access to this Space straight away.",
                      label: "Remove organisation",
                      run: () => spacesApi.removeParty(space.id, party.id),
                    })
                  }
                >
                  Remove organisation
                </Button>
              )}
            </div>
          </section>

          {admin && (
            <>
              <PartyAccess party={party} spaceId={space.id} resources={resources} act={act} />
              <section aria-labelledby="guests-heading" className="grid gap-3">
                <h2 id="guests-heading" className="text-section font-semibold">
                  Guests
                </h2>
                <InviteForm spaceId={space.id} domain={party.domain} act={act} />
                {guests.length === 0 ? (
                  <p className="text-dense text-fg-muted">Nobody has accepted an invitation yet.</p>
                ) : (
                  <ul aria-label="Guests" className="grid gap-2">
                    {guests.map((g) => (
                      <li
                        key={g.user_id}
                        className="flex flex-wrap items-center gap-3 rounded-md border border-control p-3"
                      >
                        <span className="flex-1">
                          {g.name || g.email}
                          <span className="block text-caption text-fg-muted">{g.email}</span>
                        </span>
                        <span className="text-dense text-fg-muted">
                          {g.status === "active"
                            ? `Access ends ${formatDate(g.expires_at)}`
                            : g.status === "expired"
                              ? "Expired"
                              : "Deactivated"}
                        </span>
                        <Button
                          size="sm"
                          variant="quiet"
                          aria-label={`Remove ${g.email}`}
                          onClick={() =>
                            setConfirm({
                              title: `Remove ${g.email}?`,
                              description: "They lose access to this Space straight away.",
                              label: "Remove guest",
                              run: () => spacesApi.removeGuest(space.id, g.user_id),
                            })
                          }
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm?.title ?? ""}
        description={confirm?.description ?? ""}
        confirmLabel={confirm?.label ?? "Confirm"}
        destructive
        onConfirm={() => {
          const chosen = confirm;
          setConfirm(null);
          if (chosen) void act(chosen.run());
        }}
      />
    </div>
  );
}

function PartyForm({ spaceId, onAdded }: { spaceId: string; onAdded: () => void }) {
  // Adding a guest organisation needs a fresh second factor (SEC-007).
  const stepUp = useStepUp();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [approvers, setApprovers] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const party = {
      name: name.trim(),
      domain: domain.trim(),
      connection_admin_emails: approvers.split(/[,;\s]+/).filter(Boolean),
    };
    void stepUp.run(() => spacesApi.addParty(spaceId, party), onAdded);
  };
  // The step-up prompt is a form of its own, so it sits beside this one rather than inside it.
  const form = (
    <form onSubmit={submit} aria-label="Add guest organisation" className="grid max-w-md gap-3">
      <h2 className="text-section font-semibold">Add a guest organisation</h2>
      <div className="grid gap-1">
        <Label htmlFor="party-name">Organisation name</Label>
        <Input
          id="party-name"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="party-domain">Email domain</Label>
        <Input
          id="party-domain"
          value={domain}
          placeholder="example.com"
          onChange={(e) => setDomain(e.target.value)}
          required
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="party-approvers">Their approvers' emails</Label>
        <Input
          id="party-approvers"
          value={approvers}
          placeholder="Separate with commas"
          onChange={(e) => setApprovers(e.target.value)}
        />
      </div>
      <Button
        type="submit"
        className="justify-self-start"
        disabled={stepUp.busy || !name.trim() || !domain.trim()}
      >
        Add organisation
      </Button>
    </form>
  );
  return (
    <div className="grid gap-3">
      {form}
      {stepUp.prompt}
    </div>
  );
}

function InviteForm({ spaceId, domain, act }: { spaceId: string; domain: string; act: Act }) {
  const [email, setEmail] = useState("");
  const [days, setDays] = useState("90");
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLink(null);
    await act(
      spacesApi.invite(spaceId, email.trim(), Number(days)).then((made) => {
        const url = new URL(made.accept_url, window.location.origin).href;
        setLink({ email: made.invite.email, url });
        setEmail("");
      }),
    );
  };
  return (
    <>
      <form onSubmit={submit} aria-label="Invite guest" className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-56 flex-1 gap-1">
          <Label htmlFor="invite-email">Guest email</Label>
          <Input
            id="invite-email"
            type="email"
            value={email}
            placeholder={`name@${domain}`}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="grid w-28 gap-1">
          <Label htmlFor="invite-days">Access days</Label>
          <Input
            id="invite-days"
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            required
          />
        </div>
        <Button type="submit" disabled={!email.trim()}>
          Invite
        </Button>
      </form>
      {link && (
        <div role="status" className="grid gap-2 rounded-md border border-control p-3">
          <p className="text-ui">
            Send this link to {link.email}. It isn't emailed for you and is shown only once.
          </p>
          <Input
            readOnly
            aria-label="Invitation link"
            value={link.url}
            onFocus={(e) => e.target.select()}
          />
          <Button
            size="sm"
            variant="quiet"
            className="justify-self-start"
            onClick={() =>
              navigator.clipboard.writeText(link.url).then(
                () => toast.success("Link copied."),
                () => toast.error("Select the link and copy it."),
              )
            }
          >
            Copy link
          </Button>
        </div>
      )}
    </>
  );
}

function PartyAccess({
  party,
  spaceId,
  resources,
  act,
}: {
  party: Party;
  spaceId: string;
  resources: Resource[];
  act: Act;
}) {
  return (
    <section aria-labelledby="access-heading" className="grid gap-2">
      <h2 id="access-heading" className="text-section font-semibold">
        What {party.name} can reach
      </h2>
      {party.connection.status !== "resolved" && (
        <p className="text-dense text-fg-muted">
          Nothing can be shared with them until both sides approve the connection.
        </p>
      )}
      {resources.length === 0 ? (
        <p className="text-dense text-fg-muted">Nothing is in this Space yet.</p>
      ) : (
        <ul className="grid gap-2">
          {resources.map((r) => {
            const name = r.name ?? "A resource you can't open";
            const level = r.per_party?.[party.id] ?? "none";
            const levels = partyLevels(r.resource_type);
            return (
              <li
                key={r.id}
                className="flex items-center gap-3 rounded-md border border-control p-3"
              >
                <span className="flex-1">{name}</span>
                <select
                  aria-label={`${party.name} access to ${name}`}
                  className={select}
                  value={level}
                  disabled={party.connection.status !== "resolved"}
                  onChange={(e) =>
                    act(spacesApi.setPartyLevel(spaceId, r.id, party.id, e.target.value))
                  }
                >
                  {(levels.includes(level) ? levels : [...levels, level]).map((l) => (
                    <option key={l} value={l}>
                      {LEVEL[l] ?? l}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
