import { AppShell, Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@legallabs/ui";
import { useHash } from "../vaults/route.js";
import { ConnectorsTab } from "./ConnectorsTab.js";
import { ModelsTab } from "./ModelsTab.js";
import { type AdminModelsTab, adminModelsHash, parseAdminModelsRoute } from "./route.js";

/** Admin: which models and MCP connectors the workspace may use. */
export function AdminModelsApp({ onLeave }: { onLeave: () => void }) {
  const tab = parseAdminModelsRoute(useHash())?.tab ?? "models";
  const setTab = (next: string) => {
    window.location.hash = adminModelsHash(next as AdminModelsTab);
  };
  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Admin"
      commands={[
        {
          id: "admin-models",
          kind: "action",
          group: "Admin",
          label: "Models",
          run: () => setTab("models"),
        },
        {
          id: "admin-connectors",
          kind: "action",
          group: "Admin",
          label: "Connectors",
          run: () => setTab("connectors"),
        },
        { id: "threads", kind: "action", group: "Go to", label: "Threads", run: onLeave },
      ]}
      sidebar={
        <div className="grid min-w-0 gap-2">
          <Button variant="quiet" size="sm" className="justify-start" onClick={onLeave}>
            Back to threads
          </Button>
          <p className="text-dense text-fg-muted">
            The models people can use, and the MCP servers the assistant may call.
          </p>
        </div>
      }
    >
      <main id="main" className="flex min-w-0 flex-1 flex-col overflow-auto p-6">
        <h1 className="mb-4 text-title font-semibold">Models and connectors</h1>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="models">Models</TabsTrigger>
            <TabsTrigger value="connectors">Connectors</TabsTrigger>
          </TabsList>
          <TabsContent value="models">
            <ModelsTab />
          </TabsContent>
          <TabsContent value="connectors">
            <ConnectorsTab />
          </TabsContent>
        </Tabs>
      </main>
    </AppShell>
  );
}
