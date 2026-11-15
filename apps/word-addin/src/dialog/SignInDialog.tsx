import { Button, Field, Input, StatusText } from "@legallabs/ui";
import { type FormEvent, useEffect, useState } from "react";

type Post = (path: string, body?: unknown) => Promise<Response>;

const post: Post = (path, body) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

/**
 * Runs in Office's dialog on the LegalLabs origin: an ordinary sign-in, then a
 * one-time code for the pane. The session token itself never leaves this origin's cookie.
 */
export function SignInDialog({
  send,
  request = post,
  session = () => fetch("/auth/session"),
}: {
  send: (message: string) => void;
  request?: Post;
  session?: () => Promise<Response>;
}) {
  const [workspace, setWorkspace] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handOver = async () => {
    const res = await request("/auth/addin/code");
    if (!res.ok) throw new Error("code");
    const { code } = (await res.json()) as { code: string };
    send(JSON.stringify({ code }));
  };

  // Already signed in on the web: nothing to type. Runs once, when the dialog opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  useEffect(() => {
    let live = true;
    session()
      .then((res) => (res.ok && live ? handOver() : undefined))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await request("/auth/login", { workspace, email, password });
      if (res.status === 429) setError("Too many attempts. Wait a minute, then try again.");
      else if (!res.ok) setError("That workspace, email and password don't match.");
      else await handOver();
    } catch {
      setError("Couldn't reach LegalLabs. Check your connection.");
    } finally {
      setBusy(false);
    }
  };

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
