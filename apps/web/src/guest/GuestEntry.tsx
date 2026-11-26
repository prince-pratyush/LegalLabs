import { Button, Field, Input } from "@legallabs/ui";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { messageOf } from "../api.js";
import { formatDate } from "../vaults/shared.js";
import { guestApi, type InvitePreview } from "./api.js";

export interface Prefill {
  workspace: string;
  email: string;
}

function Page({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="mx-auto grid max-w-sm gap-6 px-4 py-12">
      <h1 className="text-title font-semibold">LegalLabs</h1>
      {children}
    </main>
  );
}

const Alert = ({ text }: { text: string | null }) =>
  text ? (
    <p role="alert" className="text-destructive">
      {text}
    </p>
  ) : null;

/** The token rides in the fragment, so no server or proxy log holds it. */
export const tokenFrom = (hash: string) =>
  new URLSearchParams(hash.replace(/^#/, "")).get("token") ?? "";

/** Where an invitation link lands: what it is for, the guest's name, and joining. */
export function GuestAccept({ onJoined }: { onJoined: (prefill: Prefill) => void }) {
  const [token] = useState(() => tokenFrom(window.location.hash));
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [failed, setFailed] = useState<string | null>(token ? null : "That link is incomplete.");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (token) guestApi.preview(token).then(setInvite, (err) => setFailed(messageOf(err)));
  }, [token]);

  const join = async (event: FormEvent) => {
    event.preventDefault();
    if (!invite || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const joined = await guestApi.accept(token, name.trim());
      onJoined({ workspace: joined.workspace, email: invite.email });
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  if (failed) {
    return (
      <Page>
        <Alert text={failed} />
        <p className="text-dense text-fg-muted">Ask whoever invited you for a new link.</p>
        <p>
          <a className="underline" href="/#/guest">
            Already joined? Guest sign-in
          </a>
        </p>
      </Page>
    );
  }
  if (!invite) {
    return (
      <Page>
        <p role="status" className="text-fg-muted">
          Checking your invitation
        </p>
      </Page>
    );
  }
  return (
    <Page>
      <form onSubmit={join} className="grid gap-4">
        <h2 className="text-section font-semibold">Join {invite.space_name}</h2>
        <p className="text-ui">
          {invite.workspace_name} invited {invite.email} as a guest for {invite.party_name}. The
          invitation ends on {formatDate(invite.expires_at)}.
        </p>
        <Field label="Your name">
          {(props) => (
            <Input
              {...props}
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
            />
          )}
        </Field>
        <Alert text={error} />
        <Button type="submit" disabled={busy || !name.trim()} className="justify-self-start">
          Accept invitation
        </Button>
      </form>
    </Page>
  );
}

/** Guests have no password: an eight digit code is emailed each time. */
export function GuestSignIn({
  prefill,
  onSignedIn,
}: {
  prefill: Prefill | null;
  onSignedIn: () => void;
}) {
  const [workspace, setWorkspace] = useState(prefill?.workspace ?? "");
  const [email, setEmail] = useState(prefill?.email ?? "");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  const sendCode = () =>
    run(async () => {
      await guestApi.requestCode(workspace.trim(), email.trim());
      setSent(true);
    });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!sent) {
      void sendCode();
      return;
    }
    void run(async () => {
      await guestApi.verify(workspace.trim(), email.trim(), code.trim());
      onSignedIn();
    });
  };

  return (
    <Page>
      <form onSubmit={submit} className="grid gap-4">
        <h2 className="text-section font-semibold">Guest sign-in</h2>
        {prefill && !sent && (
          <p role="status" className="text-ui">
            You've joined. Get a code by email to sign in.
          </p>
        )}
        <Field label="Workspace">
          {(props) => (
            <Input
              {...props}
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              autoComplete="organization"
              readOnly={sent}
              required
            />
          )}
        </Field>
        <Field label="Email">
          {(props) => (
            <Input
              {...props}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              readOnly={sent}
              required
            />
          )}
        </Field>
        {sent && (
          <>
            <p role="status" className="text-ui">
              If that address has guest access, a code is on its way. It works once, for 10 minutes.
            </p>
            <Field label="8-digit code">
              {(props) => (
                <Input
                  {...props}
                  value={code}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{8}"
                  maxLength={8}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
              )}
            </Field>
          </>
        )}
        <Alert text={error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {sent ? "Sign in" : "Email me a code"}
          </Button>
          {sent && (
            <>
              <Button type="button" variant="quiet" disabled={busy} onClick={() => void sendCode()}>
                Send another code
              </Button>
              <Button
                type="button"
                variant="quiet"
                onClick={() => {
                  setSent(false);
                  setCode("");
                  setError(null);
                }}
              >
                Change address
              </Button>
            </>
          )}
        </div>
      </form>
      <p>
        <a className="underline" href="#/">
          Sign in with a password instead
        </a>
      </p>
    </Page>
  );
}
