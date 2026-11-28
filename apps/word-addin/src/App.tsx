import {
  type Api,
  createApi,
  type DialogOpener,
  messageOf,
  SignInError,
  signIn,
} from "@legallabs/addin";
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tokenStore } from "./auth/token.js";
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

const SELECTION_PAUSE_MS = 300;

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
  const anonymous = useMemo(() => createApi(() => null), []);

  // Read through refs, so one subscription serves every scope.
  const scopeRef = useRef(scope);
  const chosenRef = useRef(chosen);
  scopeRef.current = scope;
  chosenRef.current = chosen;

  const count = useCallback(async () => {
    try {
      const selection = await host.read("selection");
      // Selection is the default once something is selected, until the user picks.
      if (!chosenRef.current && selection.text.trim()) setScope("selection");
      const current = chosenRef.current || !selection.text.trim() ? scopeRef.current : "selection";
      // The document is read only when it's what the count is about.
      setChars(
        current === "selection" ? selection.text.length : (await host.read("document")).text.length,
      );
    } catch {
      setChars(null);
    }
  }, [host]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Selection events come in bursts while the user drags, so the count waits for a pause.
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void count(), SELECTION_PAUSE_MS);
    };
    void count();
    const stop = host.onSelectionChange(later);
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [host, count]);

  // A switch of scope recounts at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope is the trigger
  useEffect(() => {
    void count();
  }, [scope, count]);

  const startSignIn = async () => {
    setSigningIn(true);
    setNotice(null);
    try {
      const session = await signIn(openDialog, anonymous, `${origin}/addin/auth.html`);
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
          {/* Kept mounted, so an answer or a running review survives a tab switch. */}
          <TabsContent
            value="threads"
            forceMount
            className="min-h-0 flex-1 overflow-auto p-3 data-[state=inactive]:hidden"
          >
            <AskPanel api={api} host={host} scope={scope} origin={origin} />
          </TabsContent>
          <TabsContent
            value="library"
            forceMount
            className="min-h-0 flex-1 overflow-auto p-3 data-[state=inactive]:hidden"
          >
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
