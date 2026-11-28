import { Menu, PanelLeft, Search, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { type ReactNode, useEffect, useId, useState } from "react";
import { cn } from "../cn.js";
import { formatKeys, useHotkeys } from "../shortcuts.js";
import { useMobile } from "../use-mobile.js";
import { Button } from "./button.js";
import { CommandPalette, type PaletteCommand } from "./command-palette.js";
import { Tooltip } from "./tooltip.js";

const wide = () => typeof matchMedia !== "function" || matchMedia("(min-width: 1024px)").matches;

/** Owns the global keys, so every screen gets the same palette and panels. */
export function AppShell({
  brand,
  sidebar,
  sidebarLabel,
  children,
  panel,
  onTogglePanel,
  commands = [],
  defaultSidebarOpen,
}: {
  brand: ReactNode;
  sidebar: ReactNode;
  sidebarLabel: string;
  children: ReactNode;
  /** The open context panel, usually a SidePanel, or null when closed. */
  panel?: ReactNode;
  onTogglePanel?: () => void;
  commands?: readonly PaletteCommand[];
  defaultSidebarOpen?: boolean;
}) {
  const sidebarId = useId();
  const [sidebarOpen, setSidebarOpen] = useState(defaultSidebarOpen ?? wide);
  const [palette, setPalette] = useState<"" | "?" | null>(null);
  const mobile = useMobile();
  const [drawer, setDrawer] = useState(false);

  // Choosing a screen is the end of the drawer's job.
  useEffect(() => {
    const close = () => setDrawer(false);
    window.addEventListener("hashchange", close);
    window.addEventListener("popstate", close);
    return () => {
      window.removeEventListener("hashchange", close);
      window.removeEventListener("popstate", close);
    };
  }, []);

  const bindings: Record<string, () => void> = {
    "mod+k": () => setPalette(""),
    "?": () => setPalette("?"),
    "mod+b": () => (mobile ? setDrawer : setSidebarOpen)((open) => !open),
  };
  if (onTogglePanel) bindings["mod+/"] = onTogglePanel;
  if (onTogglePanel && panel) bindings.escape = onTogglePanel;
  for (const command of commands) if (command.shortcut) bindings[command.shortcut] = command.run;
  useHotkeys(bindings, palette === null);

  const commandPalette = (
    <CommandPalette
      key={palette ?? "closed"}
      open={palette !== null}
      onOpenChange={(open) => setPalette(open ? "" : null)}
      initialSearch={palette ?? ""}
      commands={commands}
    />
  );

  if (mobile) {
    return (
      <div className="flex h-dvh flex-col overflow-hidden bg-bg pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-fg">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg-subtle px-1">
          <Button
            variant="quiet"
            size="icon"
            aria-label="Open menu"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <Menu aria-hidden />
          </Button>
          <div className="min-w-0 flex-1 truncate text-ui font-semibold">{brand}</div>
          <Button
            variant="quiet"
            size="icon"
            aria-label="Search and commands"
            onClick={() => setPalette("")}
          >
            <Search aria-hidden />
          </Button>
        </header>
        <main id="main" tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {children}
        </main>
        {panel}
        <Dialog.Root open={drawer} onOpenChange={setDrawer}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-fg/40 animate-fade-in" />
            <Dialog.Content
              aria-describedby={undefined}
              className="fixed inset-y-0 left-0 z-40 flex w-[min(300px,85vw)] flex-col border-r border-border bg-bg-subtle pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-fg"
            >
              <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
                <Dialog.Title className="truncate text-ui font-semibold">
                  {sidebarLabel}
                </Dialog.Title>
                <Dialog.Close asChild>
                  <Button variant="quiet" size="icon" aria-label="Close menu">
                    <X aria-hidden />
                  </Button>
                </Dialog.Close>
              </div>
              <nav
                aria-label={sidebarLabel}
                className="min-h-0 flex-1 overflow-y-auto px-3 pb-4"
                // The screen already shown raises no address change, so close on that click too.
                onClickCapture={(event) => {
                  if ((event.target as Element).closest("[aria-current], a")) setDrawer(false);
                }}
              >
                {sidebar}
              </nav>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        {commandPalette}
      </div>
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-fg">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-bg-raised px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to main content
      </a>
      <nav
        aria-label={sidebarLabel}
        className={cn(
          "flex shrink-0 flex-col border-r border-border bg-bg-subtle transition-[width] duration-(--motion-panel) ease-out",
          sidebarOpen ? "w-[260px]" : "w-14",
        )}
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
          {sidebarOpen && <div className="truncate text-ui font-semibold">{brand}</div>}
          <Tooltip
            content={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            shortcut={formatKeys("mod+b")}
          >
            <Button
              variant="quiet"
              size="icon"
              aria-label="Sidebar"
              aria-expanded={sidebarOpen}
              aria-controls={sidebarId}
              onClick={() => setSidebarOpen((open) => !open)}
            >
              <PanelLeft aria-hidden />
            </Button>
          </Tooltip>
        </div>
        <div className="px-3 pb-2">
          <Tooltip content="Search and commands" shortcut={formatKeys("mod+k")}>
            <Button
              variant="secondary"
              size={sidebarOpen ? "md" : "icon"}
              className={cn(sidebarOpen && "w-full justify-start text-fg-muted")}
              aria-label={sidebarOpen ? undefined : "Search and commands"}
              onClick={() => setPalette("")}
            >
              <Search aria-hidden />
              {sidebarOpen && "Search"}
            </Button>
          </Tooltip>
        </div>
        <div
          id={sidebarId}
          hidden={!sidebarOpen}
          className="min-h-0 flex-1 overflow-y-auto px-3 pb-4"
        >
          {sidebar}
        </div>
      </nav>
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto">
        {children}
      </main>
      {panel && (
        <div className="h-full shrink-0 max-standard:absolute max-standard:inset-y-0 max-standard:right-0 max-standard:z-40 max-standard:shadow-xl">
          {panel}
        </div>
      )}
      {commandPalette}
    </div>
  );
}
