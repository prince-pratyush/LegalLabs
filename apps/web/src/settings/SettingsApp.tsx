import { AppShell, Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@legallabs/ui";
import { useHash } from "../vaults/route.js";
import { MemorySettings } from "./MemorySettings.js";
import { NotificationSettings } from "./NotificationSettings.js";
import { parseSettingsRoute, type SettingsTab, settingsHash } from "./route.js";
import { StyleSettings } from "./StyleSettings.js";

/** Personal settings: email notifications, memory and writing styles. */
export function SettingsApp({ onLeave }: { onLeave: () => void }) {
  const tab = parseSettingsRoute(useHash())?.tab ?? "notifications";
  const setTab = (next: string) => {
    window.location.hash = settingsHash(next as SettingsTab);
  };
  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Settings"
      commands={[
        {
          id: "settings-notifications",
          kind: "action",
          group: "Settings",
          label: "Email notification settings",
          run: () => setTab("notifications"),
        },
        {
          id: "settings-memory",
          kind: "action",
          group: "Settings",
          label: "Memory settings",
          run: () => setTab("memory"),
        },
        {
          id: "settings-styles",
          kind: "action",
          group: "Settings",
          label: "Writing styles",
          run: () => setTab("writing-styles"),
        },
        { id: "threads", kind: "action", group: "Go to", label: "Threads", run: onLeave },
      ]}
      sidebar={
        <div className="grid min-w-0 gap-2">
          <Button variant="quiet" size="sm" className="justify-start" onClick={onLeave}>
            Back to threads
          </Button>
          <p className="text-dense text-fg-muted">
            Your email notifications, the memory the assistant keeps about you, and your writing
            styles.
          </p>
        </div>
      }
    >
      <main id="main" className="flex min-w-0 flex-1 flex-col overflow-auto p-6">
        <h1 className="mb-4 text-title font-semibold">Settings</h1>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="notifications">Email notifications</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
            <TabsTrigger value="writing-styles">Writing styles</TabsTrigger>
          </TabsList>
          <TabsContent value="notifications">
            <NotificationSettings />
          </TabsContent>
          <TabsContent value="memory">
            <MemorySettings />
          </TabsContent>
          <TabsContent value="writing-styles">
            <StyleSettings />
          </TabsContent>
        </Tabs>
      </main>
    </AppShell>
  );
}
