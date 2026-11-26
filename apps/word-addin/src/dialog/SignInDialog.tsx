import {
  ApiError,
  Button,
  Field,
  Input,
  type Pending,
  SecondFactor,
  StatusText,
  secondFactorApi,
} from "@legallabs/ui";
import { type FormEvent, useEffect, useState } from "react";

const NO_PASSKEY =
  "This window can't use your passkey. Use a recovery code, or sign in to LegalLabs in your browser and add an authenticator app.";

/**
 * Runs in Office's dialog on the LegalLabs origin: an ordinary sign-in, second factor
 * included, then a one-time code for the pane. The session token itself never leaves
 * this origin's cookie.
 */
export function SignInDialog({ send }: { send: (message: string) => void }) {
  const [workspace, setWorkspace] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const handOver = async () => {
    const res = await fetch("/auth/addin/code", { method: "POST" });
    if (!res.ok) throw new Error("code");
    const { code } = (await res.json()) as { code: string };
    send(JSON.stringify({ code }));
  };

  // Already signed in on the web: nothing to type. Runs once, when the dialog opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  useEffect(() => {
    let live = true;
    fetch("/auth/session")
      .then((res) => (res.ok && live ? handOver() : undefined))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const unreachable = "Couldn't reach LegalLabs. Check your connection.";

  const finish = async () => {
    setBusy(true);
    try {
      await handOver();
    } catch {
      setError(unreachable);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const owed = await secondFactorApi.login(workspace.trim(), email.trim(), password);
      // The password has done its work either way, so it isn't kept on the page.
      setPassword("");
      if (owed) setPending(owed);
      else await handOver();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setError(
        status === 429
          ? "Too many attempts. Wait a minute, then try again."
          : status === 401
            ? "That workspace, email and password don't match."
            : unreachable,
      );
    } finally {
      setBusy(false);
    }
  };

  if (pending) {
    return (
      <main className="mx-auto grid max-w-sm gap-4 p-6">
        <h1 className="text-section font-semibold">Sign in to LegalLabs</h1>
        <SecondFactor
          pending={pending}
          noPasskey={NO_PASSKEY}
          onSignedIn={() => {
            setPending(null);
            void finish();
          }}
          onRestart={(why) => {
            setPending(null);
            setError(why);
          }}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto grid max-w-sm gap-4 p-6">
      <h1 className="text-section font-semibold">Sign in to LegalLabs</h1>
      <form className="grid gap-3" onSubmit={submit}>
        <Field label="Workspace">
          {(props) => (
            <Input
              {...props}
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              autoComplete="organization"
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
              required
            />
          )}
        </Field>
        <Field label="Password">
          {(props) => (
            <Input
              {...props}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          )}
        </Field>
        <p role="alert" className="text-ui">
          {error && <StatusText tone="failed">{error}</StatusText>}
        </p>
        <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
