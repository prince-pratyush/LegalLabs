import { MIN_PASSWORD_LENGTH } from "@legallabs/contracts";
import { Button, Field, Input } from "@legallabs/ui";
import { type FormEvent, useState } from "react";
import { ApiError, api, FALLBACK } from "../api.js";

export interface Joined {
  workspace: string;
  email: string;
}

/** The token of an invitation link, `#/auth/invite?token=…`. */
export function inviteTokenFrom(hash: string): string | null {
  const [path, query] = hash.split("?");
  return path === "#/auth/invite" ? new URLSearchParams(query).get("token") : null;
}

/** Where an invitation link lands: choose a password, then sign in as anyone else does. */
export function AcceptInvite({
  token,
  onJoined,
}: {
  token: string;
  onJoined: (joined: Joined) => void;
}) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== repeat) return setError("The two passwords differ.");
    setBusy(true);
    setError(null);
    try {
      onJoined(await api.acceptInvite(token, password));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? "Too many attempts. Wait a minute, then try again."
          : err instanceof ApiError
            ? err.message
            : FALLBACK,
      );
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, value: string, set: (v: string) => void) => (
    <Field label={label}>
      {(p) => (
        <Input
          {...p}
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={256}
          required
          value={value}
          onChange={(e) => set(e.target.value)}
        />
      )}
    </Field>
  );

  return (
    <main className="mx-auto grid max-w-sm gap-6 px-4 py-12">
      <h1 className="text-title font-semibold">LegalLabs</h1>
      <form onSubmit={submit} className="grid gap-4">
        <h2 className="text-section font-semibold">Choose your password</h2>
        <p className="text-dense text-fg-muted">At least {MIN_PASSWORD_LENGTH} characters.</p>
        {field("New password", password, setPassword)}
        {field("Repeat the password", repeat, setRepeat)}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy} className="justify-self-start">
          Set password
        </Button>
      </form>
    </main>
  );
}
