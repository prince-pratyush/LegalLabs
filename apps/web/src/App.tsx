import {
  AppShell,
  Button,
  EmptyState,
  Field,
  Input,
  type PaletteCommand,
  setThemeSetting,
} from "@legallabs/ui";
import { History, SquarePen } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type HistoryItem } from "./api.js";
import { HistoryPage } from "./history/HistoryPage.js";
import { navigate, paths, parseRoute, type Route, useHash } from "./router.js";
import { Shell, ShellContext, type ShellProps } from "./shell.js";
import { ThreadScreen } from "./thread/ThreadScreen.js";
import { CitationViewer } from "./viewer/CitationViewer.js";

const FALLBACK = "Something went wrong. Try again.";
const RECENTS = 5;

export function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    api.session().then(
      () => setSignedIn(true),
      () => setSignedIn(false),
    );
  }, []);
  if (signedIn === null) return <p className="p-6 text-fg-muted">Loading…</p>;
  return signedIn ? (
    <Workspace onSignedOut={() => setSignedIn(false)} />
  ) : (
    <SignIn onSignedIn={() => setSignedIn(true)} />
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [workspace, setWorkspace] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(workspace.trim(), email.trim(), password);
      onSignedIn();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(
        status === 401
          ? "Those details didn't match an account."
          : status === 429
            ? "Too many attempts. Wait a minute, then try again."
            : status === 400
              ? "Check the workspace, email and password."
              : FALLBACK,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto grid max-w-sm gap-6 px-4 py-12">
      <h1 className="text-title font-semibold">LegalLabs</h1>
      <form onSubmit={submit} className="grid gap-4">
        <h2 className="text-section font-semibold">Sign in</h2>
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
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy} className="justify-self-start">
          Sign in
        </Button>
      </form>
    </main>
  );
}

function pathOf(route: Route): string {
  if (route.name === "thread") return paths.thread(route.id);
  if (route.name === "history") return paths.history;
  return paths.new;
}

function Workspace({ onSignedOut }: { onSignedOut: () => void }) {
  const route = parseRoute(useHash());
  // A citation opens beside whatever was showing, so the thread stays in view.
  const behind = useRef<Route>({ name: "new" });
  if (route.name !== "viewer") behind.current = route;
  const screen = behind.current;
  const [recents, setRecents] = useState<HistoryItem[]>([]);

  const refreshRecents = useCallback(() => {
    api.history().then(
      (page) => setRecents(page.items.slice(0, RECENTS)),
      () => undefined,
    );
  }, []);
  useEffect(refreshRecents, [refreshRecents]);

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    onSignedOut();
  };

  const closeViewer = () => navigate(pathOf(behind.current));
  const overlay =
    route.name === "viewer" ? (
      <CitationViewer
        key={route.path}
        target={route.target}
        path={route.path}
        onClose={closeViewer}
      />
    ) : null;

  const commands: PaletteCommand[] = [
    ...recents.map(
      (item): PaletteCommand => ({
        id: `thread-${item.id}`,
        kind: "object",
        group: "Recent threads",
        label: item.title,
        run: () => navigate(paths.thread(item.id)),
      }),
    ),
    {
      id: "new",
      kind: "action",
      group: "Actions",
      label: "New thread",
      run: () => navigate(paths.new),
    },
    {
      id: "history",
      kind: "action",
      group: "Actions",
      label: "Open history",
      run: () => navigate(paths.history),
    },
    {
      id: "light",
      kind: "action",
      group: "Settings",
      label: "Use the light theme",
      run: () => setThemeSetting("light"),
    },
    {
      id: "dark",
      kind: "action",
      group: "Settings",
      label: "Use the dark theme",
      run: () => setThemeSetting("dark"),
    },
    {
      id: "system",
      kind: "action",
      group: "Settings",
      label: "Match the system theme",
      run: () => setThemeSetting("system"),
    },
    { id: "sign-out", kind: "action", group: "Account", label: "Sign out", run: signOut },
  ];

  const current = (match: boolean) => (match ? ("page" as const) : undefined);

  const sidebar = (
    <div className="grid min-w-0 gap-6">
      <div className="grid gap-1">
        <Button
          variant="secondary"
          size="sm"
          className="justify-start"
          aria-current={current(screen.name === "new")}
          onClick={() => navigate(paths.new)}
        >
          <SquarePen aria-hidden />
          New thread
        </Button>
        <Button
          variant="quiet"
          size="sm"
          className="justify-start aria-[current]:tint-selected"
          aria-current={current(screen.name === "history")}
          onClick={() => navigate(paths.history)}
        >
          <History aria-hidden />
          History
        </Button>
      </div>
      <section className="grid gap-2" aria-labelledby="recents-heading">
        <h2 id="recents-heading" className="text-caption font-semibold text-fg-muted uppercase">
          Recents
        </h2>
        {recents.length === 0 ? (
          <p className="text-dense text-fg-muted">Your threads will show here.</p>
        ) : (
          <ul className="grid">
            {recents.map((item) => (
              <li key={item.id}>
                <Button
                  variant="quiet"
                  size="sm"
                  className="w-full justify-start truncate aria-[current]:tint-selected"
                  aria-current={current(screen.name === "thread" && screen.id === item.id)}
                  onClick={() => navigate(paths.thread(item.id))}
                >
                  {item.title}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Button variant="quiet" size="sm" className="justify-start" onClick={signOut}>
        Sign out
      </Button>
    </div>
  );

  const frame = ({ panel, onTogglePanel, children }: ShellProps): ReactNode => (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Threads"
      commands={commands}
      sidebar={sidebar}
      panel={overlay ?? panel}
      {...(overlay ? { onTogglePanel: closeViewer } : onTogglePanel ? { onTogglePanel } : {})}
    >
      {children}
    </AppShell>
  );

  return (
    <ShellContext.Provider value={frame}>
      {screen.name === "new" ? (
        <ThreadScreen key="new" threadId={null} onChanged={refreshRecents} />
      ) : screen.name === "thread" ? (
        <ThreadScreen key={screen.id} threadId={screen.id} onChanged={refreshRecents} />
      ) : screen.name === "history" ? (
        <HistoryPage onFavourite={refreshRecents} />
      ) : (
        <Shell>
          <EmptyState
            title="Page not found"
            description="That link doesn't lead anywhere."
            action={{ label: "Start a new thread", onClick: () => navigate(paths.new) }}
          />
        </Shell>
      )}
    </ShellContext.Provider>
  );
}
