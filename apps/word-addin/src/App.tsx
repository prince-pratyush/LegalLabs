import {
  Button,
  formatCount,
  StatusText,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@legallabs/ui";
import { LogOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Api, createApi } from "./api.js";
import { type DialogOpener, SignInError, signIn, tokenStore } from "./auth/session.js";
import { LibraryPanel } from "./library/LibraryPanel.js";
import type { Scope, WordHost } from "./office/host.js";
import { AskPanel } from "./threads/AskPanel.js";

function ScopeSwitch({
  scope,
  onScope,
  chars,
}: {
  scope: Scope;
  onScope: (scope: Scope) => void;
  chars: number | null;
}) {
  const option = (value: Scope, label: string) => (
    <label className="flex h-7 cursor-pointer items-center rounded px-2 text-dense font-medium text-fg-muted has-checked:bg-bg-raised has-checked:text-fg has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-accent">
      <input
        type="radio"
        name="scope"
        value={value}
        checked={scope === value}
        onChange={() => onScope(value)}
        className="sr-only"
      />
      {label}
    </label>
  );
  return (
    <div className="flex items-center gap-2">
      <fieldset className="flex rounded-md bg-bg-subtle p-0.5">
        <legend className="sr-only">What to work on</legend>
        {option("selection", "Selection")}
        {option("document", "Document")}
      </fieldset>
      {chars !== null && (
        <span className="text-caption text-fg-muted tabular-nums" aria-live="polite">
          {formatCount(chars)} chars
        </span>
      )}
    </div>
  );
}

/** The task pane: one column, Word is the viewer, tabs at the bottom (UX §9.5). */
export function App({
  host,
  origin,
  openDialog,
}: {
  host: WordHost;
  origin: string;
  openDialog: DialogOpener;
}) {
  const [token, setToken] = useState<string | null>(() => tokenStore.read());
  const [notice, setNotice] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [scope, setScope] = useState<Scope>("document");
  const [chosen, setChosen] = useState(false);
  const [chars, setChars] = useState<number | null>(null);

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
          )
        : null,
    [token, signedOut],
  );
  // Only for the exchange, which runs before there is a token.
  const anonymous = useMemo(
    () =>
      createApi(
        () => null,
        () => {},
      ),
    [],
  );

  useEffect(() => {
    let live = true;
    const count = () =>
      void host
        .read(scope)
        .then((text) => {
          if (!live) return;
          setChars(text.text.length);
          // Selection is the default once something is selected, until the user picks.
          if (!chosen && scope === "document") {
            void host.read("selection").then((s) => live && s.text.trim() && setScope("selection"));
          }
        })
        .catch(() => live && setChars(null));
    count();
    const stop = host.onSelectionChange(count);
    return () => {
      live = false;
      stop();
    };
  }, [host, scope, chosen]);

  const startSignIn = async () => {
    setSigningIn(true);
    setNotice(null);
    try {
      const session = await signIn(openDialog, anonymous, origin);
      tokenStore.write(session.token);
      setToken(session.token);
    } catch (err) {
      setNotice(
        err instanceof SignInError && err.reason === "closed" ? null : (err as Error).message,
      );
    } finally {
      setSigningIn(false);
    }
  };

  const signOut = async () => {
    await api?.post("/auth/logout").catch(() => {});
    signedOut(null);
  };

  return (
    <div className="flex h-dvh flex-col bg-bg text-fg">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <ScopeSwitch
          scope={scope}
          chars={chars}
          onScope={(next) => {
            setChosen(true);
            setScope(next);
          }}
        />
        {api && (
          <Button size="icon" variant="quiet" aria-label="Sign out" onClick={() => void signOut()}>
            <LogOut />
          </Button>
        )}
      </header>
      {!host.capabilities.tracked && (
        <p className="border-b border-border bg-bg-subtle px-3 py-2 text-dense">
          This version of Word can't make tracked changes from an add-in, so suggestions can be
          copied but not applied.
        </p>
      )}
      {!api ? (
        <main className="grid flex-1 content-start gap-3 overflow-auto p-3">
          <h1 className="text-section font-semibold">LegalLabs for Word</h1>
          <p className="text-ui text-fg-muted">
            Sign in to ask about this document, review it against a playbook, proofread or
            translate.
          </p>
          <Button disabled={signingIn} onClick={() => void startSignIn()}>
            {signingIn ? "Signing in…" : "Sign in"}
          </Button>
          {notice && <StatusText tone="warning">{notice}</StatusText>}
          {import.meta.env.DEV && <LibraryPanel api={null} host={host} scope={scope} />}
        </main>
      ) : (
        <Tabs defaultValue="threads" className="flex min-h-0 flex-1 flex-col">
          <TabsContent value="threads" className="min-h-0 flex-1 overflow-auto p-3">
            <AskPanel api={api} host={host} scope={scope} origin={origin} />
          </TabsContent>
          <TabsContent value="library" className="min-h-0 flex-1 overflow-auto p-3">
            <LibraryPanel api={api} host={host} scope={scope} />
          </TabsContent>
          <TabsList className="border-t border-border">
            <TabsTrigger value="threads">Threads</TabsTrigger>
            <TabsTrigger value="library">Library</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
    </div>
  );
}
