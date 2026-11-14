import { PanelLeft, Search } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { cn } from "../cn.js";
import { formatKeys, useHotkeys } from "../shortcuts.js";
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

  const bindings: Record<string, () => void> = {
    "mod+k": () => setPalette(""),
    "?": () => setPalette("?"),
    "mod+b": () => setSidebarOpen((open) => !open),
  };
  if (onTogglePanel) bindings["mod+/"] = onTogglePanel;
  if (onTogglePanel && panel) bindings.escape = onTogglePanel;
  for (const command of commands) if (command.shortcut) bindings[command.shortcut] = command.run;
  useHotkeys(bindings, palette === null);

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
      <CommandPalette
        key={palette ?? "closed"}
        open={palette !== null}
        onOpenChange={(open) => setPalette(open ? "" : null)}
        initialSearch={palette ?? ""}
        commands={commands}
      />
    </div>
  );
}
