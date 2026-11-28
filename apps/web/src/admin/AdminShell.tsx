import { AppShell, Button, type PaletteCommand } from "@legallabs/ui";
import type { ReactNode } from "react";

/** The admin screens, in the order the sidebar and the command palette list them. */
export const ADMIN_PAGES = [
  { id: "command-center", label: "Command Center", hash: "#/admin/command-center/overview" },
  { id: "retention", label: "Retention", hash: "#/admin/retention/policies" },
  { id: "models", label: "Models and connectors", hash: "#/admin/models" },
  { id: "web-search", label: "Web search", hash: "#/admin/web-search" },
] as const;

export type AdminPage = (typeof ADMIN_PAGES)[number]["id"];

const open = (hash: string) => {
  window.location.hash = hash;
};

export function AdminShell({
  page,
  title,
  note,
  onLeave,
  children,
}: {
  page: AdminPage;
  title: string;
  note: string;
  onLeave: () => void;
  children: ReactNode;
}) {
  const commands: PaletteCommand[] = [
    ...ADMIN_PAGES.map(
      (p): PaletteCommand => ({
        id: `admin-${p.id}`,
        kind: "action",
        group: "Admin",
        label: p.label,
        run: () => open(p.hash),
      }),
    ),
    { id: "threads", kind: "action", group: "Go to", label: "Threads", run: onLeave },
  ];
  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Admin"
      commands={commands}
      sidebar={
        <nav aria-label="Admin pages" className="grid min-w-0 gap-1">
          <Button variant="quiet" size="sm" className="justify-start" onClick={onLeave}>
            Back to threads
          </Button>
          {ADMIN_PAGES.map((p) => (
            <Button
              key={p.id}
              variant="quiet"
              size="sm"
              className="justify-start aria-[current]:tint-selected"
              aria-current={p.id === page ? "page" : undefined}
              onClick={() => open(p.hash)}
            >
              {p.label}
            </Button>
          ))}
          <p className="text-dense text-fg-muted">{note}</p>
        </nav>
      }
    >
      <main id="main" className="relative flex min-w-0 flex-1 flex-col overflow-auto p-6">
        <h1 className="mb-4 text-title font-semibold">{title}</h1>
        {children}
      </main>
    </AppShell>
  );
}
