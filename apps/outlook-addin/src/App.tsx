import {
  type Api,
  createApi,
  type DialogOpener,
  messageOf,
  SignInError,
  signIn,
} from "@legallabs/addin";
import { Button, StatusText } from "@legallabs/ui";
import { LogOut } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { tokenStore } from "./auth/token.js";
import type { MailHost, MailItem } from "./office/host.js";

export const contextLabel = (item: MailItem) => {
  const n = item.attachments.filter((a) => !a.inline).length;
  return n === 0 ? "This email" : `This email (+ ${n} attachment${n === 1 ? "" : "s"})`;
};

/** The task pane: one column beside the message Outlook is showing. */
export function App({
  host,
  origin,
  openDialog,
}: {
  host: MailHost;
  origin: string;
  openDialog: DialogOpener;
}) {
  const [token, setToken] = useState<string | null>(() => tokenStore.read());
  const [notice, setNotice] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const signedOut = useCallback((message: string | null) => {
    tokenStore.write(null);
    setToken(null);
    setNotice(message);
  }, []);

  const api: Api | null = useMemo(
    () =>
      token
        ? createApi(
            () => token,
            () => signedOut("Your session ended. Sign in again to carry on."),
            undefined,
            "outlook",
          )
        : null,
    [token, signedOut],
  );
  // Only for the exchange, which runs before there is a token.
  const anonymous = useMemo(() => createApi(() => null, undefined, undefined, "outlook"), []);

  const startSignIn = async () => {
    setSigningIn(true);
    setNotice(null);
    try {
      const session = await signIn(openDialog, anonymous, `${origin}/outlook/auth.html`);
      tokenStore.write(session.token);
      setToken(session.token);
    } catch (err) {
      setNotice(
        err instanceof SignInError
          ? err.reason === "closed"
            ? null
            : err.message
          : messageOf(err),
      );
    } finally {
      setSigningIn(false);
    }
  };

  const signOut = async () => {
    await api?.post("/auth/logout").catch(() => {});
    signedOut(null);
  };

  const item = host.item();

  return (
    <div className="flex h-dvh flex-col bg-bg text-fg">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-ui font-semibold">LegalLabs</span>
        {api && (
          <Button size="icon" variant="quiet" aria-label="Sign out" onClick={() => void signOut()}>
            <LogOut />
          </Button>
        )}
      </header>
      <main className="grid min-h-0 flex-1 content-start gap-3 overflow-auto p-3">
        {!api ? (
          <>
            <h1 className="text-section font-semibold">LegalLabs for Outlook</h1>
            <p className="text-ui text-fg-muted">
              Sign in to ask about an email and its attachments, draft a reply and save them to a
              vault.
            </p>
            <Button disabled={signingIn} onClick={() => void startSignIn()}>
              {signingIn ? "Signing in…" : "Sign in"}
            </Button>
            {notice && <StatusText tone="warning">{notice}</StatusText>}
          </>
        ) : item ? (
          <section aria-label="Open email" className="grid gap-1 rounded-md bg-bg-subtle p-2">
            <p className="text-caption text-fg-muted">{contextLabel(item)}</p>
            <p className="truncate text-ui font-medium">{item.subject || "(no subject)"}</p>
            <p className="truncate text-dense text-fg-muted">{item.from}</p>
          </section>
        ) : (
          <p className="text-ui text-fg-muted">Open an email to ask about it.</p>
        )}
      </main>
    </div>
  );
}
