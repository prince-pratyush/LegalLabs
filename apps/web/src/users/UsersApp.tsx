import type {
  Group,
  Invitation,
  InviteResult,
  ManagedUser,
  Role,
  UserDirectory,
} from "@legallabs/contracts";
import { Button, Checkbox, ConfirmDialog, Field, Input } from "@legallabs/ui";
import { type FormEvent, useState } from "react";
import { AdminShell } from "../admin/AdminShell.js";
import { Panel, useLoad } from "../admin/load.js";
import { useStepUp } from "../retention/StepUp.js";
import { usersApi } from "./api.js";

const SELECT = "h-9 rounded-md border border-border bg-bg px-2 text-ui";
const STATUS: Record<ManagedUser["status"], string> = {
  invited: "Invited",
  active: "Active",
  suspended: "Deactivated",
  deprovisioned: "Removed",
};
const SKIPPED = {
  exists: "is already in the workspace.",
  duplicate: "was listed twice.",
  invalid: "is not an email address.",
};

const delivered = (i: Invitation) => {
  if (i.delivery === "email") return `Invitation emailed to ${i.email}.`;
  if (i.delivery === "sso") return `${i.email} can now sign in with single sign-on.`;
  if (i.delivery === "failed") {
    return `${i.email} was added, but the email didn't send. Resend it from the list.`;
  }
  return `Send this link to ${i.email}. It works once and won't be shown again.`;
};

function Outcome({ result }: { result: InviteResult }) {
  return (
    <ul className="grid gap-2 rounded-md border border-border p-3 text-ui" aria-live="polite">
      {result.invited.map((i) => (
        <li key={i.id} className="grid gap-1">
          <span>{delivered(i)}</span>
          {i.link && (
            <Input
              readOnly
              aria-label={`Link for ${i.email}`}
              value={i.link}
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
        </li>
      ))}
      {result.skipped.map((s) => (
        <li key={`${s.email}-${s.reason}`} className="text-fg-muted">
          {s.email} {SKIPPED[s.reason]}
        </li>
      ))}
    </ul>
  );
}

function GroupBoxes({
  groups,
  value,
  verb,
  onChange,
}: {
  groups: Group[];
  value: string[];
  verb: (name: string) => string;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-3">
      {groups.map((g) => (
        <div key={g.id} className="flex items-center gap-2 text-ui">
          <Checkbox
            aria-label={verb(g.name)}
            checked={value.includes(g.id)}
            onCheckedChange={(on) =>
              onChange(on === true ? [...value, g.id] : value.filter((x) => x !== g.id))
            }
          />
          {g.name}
        </div>
      ))}
    </div>
  );
}

/** Makes a change, asking for a second factor first where the server wants one. */
type Act = (work: () => Promise<InviteResult | null>, done?: () => void) => void;

function Invite({ roles, groups, act }: { roles: Role[]; groups: Group[]; act: Act }) {
  // Administrators are made from the list, once someone has joined.
  const offered = roles.filter((r) => !r.admin);
  const [emails, setEmails] = useState("");
  const [chosen, setChosen] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const role = chosen || offered.find((r) => r.builtin)?.id || offered[0]?.id || "";
  const list = emails.split(/[\s,;]+/).filter(Boolean);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    act(
      () => usersApi.invite({ emails: list, role_id: role, group_ids: picked }),
      () => setEmails(""),
    );
  };

  return (
    <section aria-label="Invite people" className="grid max-w-2xl gap-3">
      <h2 className="text-section font-semibold">Invite people</h2>
      <form onSubmit={submit} className="grid gap-3">
        <Field label="Email addresses">
          {(p) => (
            <textarea
              {...p}
              rows={3}
              className="rounded-md border border-border bg-bg p-2 text-ui"
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
            />
          )}
        </Field>
        <Field label="Role">
          {(p) => (
            <select
              {...p}
              className={SELECT}
              value={role}
              onChange={(e) => setChosen(e.target.value)}
            >
              {offered.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <GroupBoxes
          groups={groups.filter((g) => g.manageable)}
          value={picked}
          verb={(name) => `Add to ${name}`}
          onChange={setPicked}
        />
        <Button type="submit" className="justify-self-start" disabled={!list.length || !role}>
          Invite
        </Button>
      </form>
    </section>
  );
}

function Person({
  user,
  roles,
  groups,
  scim,
  act,
}: {
  user: ManagedUser;
  roles: Role[];
  groups: Group[];
  scim: boolean;
  act: Act;
}) {
  const [nextRole, setNextRole] = useState<Role | null>(null);
  const manageable = groups.filter((g) => g.manageable);
  const off = user.status === "suspended" || user.status === "deprovisioned";
  const theirs = user.source === "scim";
  const change = (patch: Parameters<typeof usersApi.update>[1]) =>
    act(() => usersApi.update(user.id, patch).then(() => null));

  return (
    <li className="grid gap-2 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 break-all font-medium">{user.email}</span>
        {user.is_self && <span className="text-dense text-fg-muted">You</span>}
        <span className="text-dense text-fg-muted">{STATUS[user.status]}</span>
        {theirs && <span className="text-dense text-fg-muted">From your identity provider</span>}
        {user.is_self || user.role_from_group ? (
          <span className="text-ui">{user.role_name ?? "No role"}</span>
        ) : (
          <select
            aria-label={`Role of ${user.email}`}
            className={SELECT}
            value={user.role_id ?? ""}
            onChange={(e) => setNextRole(roles.find((r) => r.id === e.target.value) ?? null)}
          >
            {!user.role_id && <option value="">No role</option>}
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
        {user.status === "invited" && !theirs && !scim && (
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Resend invitation to ${user.email}`}
            onClick={() =>
              act(() => usersApi.resend(user.id).then((i) => ({ invited: [i], skipped: [] })))
            }
          >
            Resend
          </Button>
        )}
        {!user.is_self && !theirs && off && (
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Reactivate ${user.email}`}
            onClick={() => change({ status: "active" })}
          >
            Reactivate
          </Button>
        )}
        {!user.is_self && !theirs && !off && (
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="quiet" aria-label={`Deactivate ${user.email}`}>
                Deactivate
              </Button>
            }
            title={`Deactivate ${user.email}?`}
            description="They are signed out at once and can't sign in until reactivated."
            confirmLabel="Deactivate"
            destructive
            onConfirm={() => change({ status: "suspended" })}
          />
        )}
      </div>
      {!user.is_self && manageable.length > 0 && (
        <GroupBoxes
          groups={manageable}
          value={user.group_ids.filter((id) => manageable.some((g) => g.id === id))}
          verb={(name) => `${user.email} in ${name}`}
          onChange={(group_ids) => change({ group_ids })}
        />
      )}
      <ConfirmDialog
        open={nextRole !== null}
        onOpenChange={(open) => !open && setNextRole(null)}
        title={`Make ${user.email} ${nextRole?.name ?? ""}?`}
        description={
          nextRole?.admin
            ? "This gives administrator rights. They are signed out and sign in again."
            : "They are signed out and sign in again."
        }
        confirmLabel="Change role"
        onConfirm={() => nextRole && change({ role_id: nextRole.id })}
      />
    </li>
  );
}

function NewGroup({ act }: { act: Act }) {
  const [name, setName] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    act(
      () => usersApi.createGroup(name.trim()).then(() => null),
      () => setName(""),
    );
  };
  return (
    <form onSubmit={submit} className="flex max-w-md items-end gap-2">
      <Field label="New group">
        {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Button type="submit" variant="secondary" disabled={!name.trim()}>
        Create group
      </Button>
    </form>
  );
}

function View({
  directory,
  roles,
  groups,
  act,
}: {
  directory: UserDirectory;
  roles: Role[];
  groups: Group[];
  act: Act;
}) {
  return (
    <>
      {directory.scim_enabled ? (
        <p className="text-ui">Users are managed by your identity provider.</p>
      ) : (
        <>
          <p className="text-dense text-fg-muted">
            {directory.sso_enabled
              ? "Single sign-on is on: people you add sign in through your identity provider."
              : directory.mail_configured
                ? "Invitations are emailed."
                : "No mail server is set up, so each link is shown to you once to pass on."}
          </p>
          <Invite roles={roles} groups={groups} act={act} />
        </>
      )}
      <section aria-label="People" className="grid gap-2">
        <h2 className="text-section font-semibold">People</h2>
        <ul className="divide-y divide-border">
          {directory.items.map((user) => (
            <Person
              key={user.id}
              user={user}
              roles={roles}
              groups={groups}
              scim={directory.scim_enabled}
              act={act}
            />
          ))}
        </ul>
      </section>
      <NewGroup act={act} />
    </>
  );
}

/** Admin: who is in the workspace, what role they hold and which groups they are in. */
export function UsersApp({ onLeave }: { onLeave: () => void }) {
  const state = useLoad(usersApi.load, []);
  const { run, prompt } = useStepUp();
  const [result, setResult] = useState<InviteResult | null>(null);
  // Kept while reloading, so the list doesn't blink out after each change.
  const [shown, setShown] = useState(state.data);
  if (state.data && state.data !== shown) setShown(state.data);

  const act: Act = (work, done) => {
    let outcome: InviteResult | null = null;
    void run(
      async () => {
        outcome = await work();
      },
      () => {
        if (outcome) setResult(outcome);
        done?.();
        state.reload();
      },
    );
  };

  return (
    <AdminShell
      page="users"
      title="Users and groups"
      note="Who can sign in, and what they may do."
      onLeave={onLeave}
    >
      <div className="grid gap-6">
        {prompt}
        {result && <Outcome result={result} />}
        <Panel state={shown && !state.error ? { ...state, data: shown } : state}>
          {(data) => <View {...data} act={act} />}
        </Panel>
      </div>
    </AdminShell>
  );
}
