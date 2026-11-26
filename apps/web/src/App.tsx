import {
  AppShell,
  Button,
  EmptyState,
  Field,
  Input,
  type PaletteCommand,
  setThemeSetting,
} from "@legallabs/ui";
import {
  BookMarked,
  Bot,
  Briefcase,
  ClipboardList,
  History,
  Library,
  Settings,
  SquarePen,
  Table,
  Users,
} from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { AdminModelsApp } from "./admin-models/AdminModelsApp.js";
import { adminModelsHash, parseAdminModelsRoute } from "./admin-models/route.js";
import { AgentsApp } from "./agents/AgentsApp.js";
import { goAgents, parseAgentRoute } from "./agents/route.js";
import { ApiError, api, type HistoryItem } from "./api.js";
import { CommandCenterApp } from "./command-center/CommandCenterApp.js";
import { commandCenterHash, parseCommandCenterRoute } from "./command-center/route.js";
import { HistoryPage } from "./history/HistoryPage.js";
import { LibraryApp } from "./library/LibraryApp.js";
import { libraryHash, parseLibraryRoute } from "./library/route.js";
import { MattersApp } from "./matters/MattersApp.js";
import { mattersHash, parseMattersRoute } from "./matters/route.js";
import { NotificationBell } from "./notifications/NotificationHub.js";
import { PlaybooksApp } from "./playbooks/PlaybooksApp.js";
import { goPlaybooks, parsePlaybookRoute } from "./playbooks/route.js";
import { RetentionApp } from "./retention/RetentionApp.js";
import { parseRetentionRoute, retentionHash } from "./retention/route.js";
import { ReviewsApp } from "./reviews/ReviewsApp.js";
import { parseReviewRoute } from "./reviews/route.js";
import { navigate, parseRoute, paths, useHash } from "./router.js";
import { parseSettingsRoute, settingsHash } from "./settings/route.js";
import { SettingsApp } from "./settings/SettingsApp.js";
import { Shell, ShellContext, type ShellProps } from "./shell.js";
import { parseSpaceRoute, spacesHash } from "./spaces/route.js";
import { SpacesApp } from "./spaces/SpacesApp.js";
import { goTables, parseTableRoute } from "./tables/route.js";
import { TablesApp } from "./tables/TablesApp.js";
import { ThreadScreen } from "./thread/ThreadScreen.js";
import { go, parseRoute as parseVaultRoute } from "./vaults/route.js";
import { VaultsApp } from "./vaults/VaultsApp.js";
import { DocumentPage, isDocumentHref } from "./viewer/document-page.js";
import { useLocation, useReturnFocus } from "./viewer/open-citation.js";

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
  const location = useLocation();
  const viewing = isDocumentHref(location.href);
  useReturnFocus(viewing);
  // Opening a document pushes a path without the hash, so the screen behind it is remembered.
  const current = useHash();
  const [hash, setHash] = useState(current);
  if (!viewing && hash !== current) setHash(current);
  if (signedIn === null) return <p className="p-6 text-fg-muted">Loading…</p>;
  if (!signedIn) return <SignIn onSignedIn={() => setSignedIn(true)} />;
  return (
    <>
      {/* Inert while the viewer covers it, so Tab and screen readers stay in the viewer. */}
      <div className="contents" inert={viewing}>
        {parseAgentRoute(hash) ? (
          <AgentsApp onLeave={() => navigate(paths.new)} />
        ) : parseMattersRoute(hash) ? (
          <MattersApp onLeave={() => navigate(paths.new)} />
        ) : parseTableRoute(hash) ? (
          <TablesApp onLeave={() => navigate(paths.new)} />
        ) : parseReviewRoute(hash) ? (
          <ReviewsApp onLeave={() => navigate(paths.new)} />
        ) : parsePlaybookRoute(hash) ? (
          <PlaybooksApp onLeave={() => navigate(paths.new)} />
        ) : parseCommandCenterRoute(hash) ? (
          <CommandCenterApp onLeave={() => navigate(paths.new)} />
        ) : parseRetentionRoute(hash) ? (
          <RetentionApp onLeave={() => navigate(paths.new)} />
        ) : parseAdminModelsRoute(hash) ? (
          <AdminModelsApp onLeave={() => navigate(paths.new)} />
        ) : parseSettingsRoute(hash) ? (
          <SettingsApp onLeave={() => navigate(paths.new)} />
        ) : parseSpaceRoute(hash) ? (
          <SpacesApp onLeave={() => navigate(paths.new)} />
        ) : parseLibraryRoute(hash) ? (
          <LibraryApp onLeave={() => navigate(paths.new)} />
        ) : parseVaultRoute(hash) ? (
          <VaultsApp onLeave={() => navigate(paths.new)} />
        ) : (
          <Workspace hash={hash} onSignedOut={() => setSignedIn(false)} />
        )}
      </div>
      {/* Over the page, not instead of it, so closing returns to the same place. */}
      {viewing ? (
        <div className="fixed inset-0 z-40 bg-bg">
          <DocumentPage href={location.href} state={location.state} />
        </div>
      ) : null}
    </>
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

function Workspace({ hash, onSignedOut }: { hash: string; onSignedOut: () => void }) {
  const screen = parseRoute(hash);
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
      id: "vaults",
      kind: "action",
      group: "Go to",
      label: "Vaults",
      run: () => go({ page: "list" }),
    },
    {
      id: "agents",
      kind: "action",
      group: "Go to",
      label: "Agents",
      run: () => goAgents({ page: "list" }),
    },
    {
      id: "playbooks",
      kind: "action",
      group: "Go to",
      label: "Playbooks",
      run: () => goPlaybooks({ page: "list" }),
    },
    {
      id: "tables",
      kind: "action",
      group: "Go to",
      label: "Review tables",
      run: () => goTables({ page: "list", threadId: null }),
    },
    {
      id: "spaces",
      kind: "action",
      group: "Go to",
      label: "Spaces",
      run: () => navigate(spacesHash().slice(1)),
    },
    {
      id: "library",
      kind: "action",
      group: "Go to",
      label: "Library",
      run: () => navigate(libraryHash().slice(1)),
    },
    {
      id: "matters",
      kind: "action",
      group: "Go to",
      label: "Matters & Walls",
      run: () => navigate(mattersHash().slice(1)),
    },
    {
      id: "settings",
      kind: "action",
      group: "Go to",
      label: "Settings",
      run: () => navigate(settingsHash().slice(1)),
    },
    {
      id: "admin-command-center",
      kind: "action",
      group: "Go to",
      label: "Admin: Command Center",
      run: () => navigate(commandCenterHash().slice(1)),
    },
    {
      id: "admin-retention",
      kind: "action",
      group: "Go to",
      label: "Admin: Retention and legal holds",
      run: () => navigate(retentionHash().slice(1)),
    },
    {
      id: "admin-models",
      kind: "action",
      group: "Go to",
      label: "Admin: Models and connectors",
      run: () => navigate(adminModelsHash().slice(1)),
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
        <Button
          variant="quiet"
          size="sm"
          className="justify-start"
          onClick={() => go({ page: "list" })}
        >
          <Library aria-hidden />
          Vaults
        </Button>
        <Button
          variant="quiet"
          size="sm"
          className="justify-start"
          onClick={() => goAgents({ page: "list" })}
        >
          <Bot aria-hidden />
          Agents
        </Button>
        <Button
          variant="quiet"
          size="sm"
          className="justify-start"
          onClick={() => goPlaybooks({ page: "list" })}
        >
          <ClipboardList aria-hidden />
          Playbooks
        </Button>
        <Button
          variant="quiet"
          size="sm"
          className="justify-start"
          onClick={() => goTables({ page: "list", threadId: null })}
        >
          <Table aria-hidden />
          Review tables
        </Button>
        <Button
          variant="quiet"
          size="sm"
          className="justify-start"
          onClick={() => navigate(libraryHash().slice(1))}
        >
          <BookMarked aria-hidden />
          Library
        </Button>
        <Button
          variant="quiet"
          size="sm"
          className="justify-start"
          onClick={() => navigate(mattersHash().slice(1))}
        >
          <Briefcase aria-hidden />
          Matters &amp; Walls
        </Button>
        <Button
          variant="quiet"
          size="sm"
          className="justify-start"
          onClick={() => navigate(spacesHash().slice(1))}
        >
          <Users aria-hidden />
          Spaces
        </Button>
        <NotificationBell />
        <Button
          variant="quiet"
          size="sm"
          className="justify-start"
          onClick={() => navigate(settingsHash().slice(1))}
        >
          <Settings aria-hidden />
          Settings
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
      panel={panel}
      {...(onTogglePanel ? { onTogglePanel } : {})}
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
