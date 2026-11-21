import {
  AppShell,
  Button,
  SidePanel,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@legallabs/ui";
import { useCallback, useEffect, useState } from "react";
import { useHash } from "../router.js";
import { type Matter, type MatterOptions, matterApi, messageOf } from "./api.js";
import {
  AddMatterForm,
  ImportMatters,
  MatterEditor,
  type MattersPanel,
  MattersTable,
  OptionsForm,
} from "./MattersTab.js";
import { type MattersTab, mattersHash, parseMattersRoute } from "./route.js";
import { WallsTab } from "./WallsTab.js";

const TITLES: Record<MattersPanel["kind"], string> = {
  add: "Add matter",
  import: "Import matters",
  options: "Matter options",
  matter: "Matter",
};

/** Command Center → Matters & Walls. */
export function MattersApp({ onLeave }: { onLeave: () => void }) {
  const tab = parseMattersRoute(useHash())?.tab ?? "matters";
  const [query, setQuery] = useState("");
  const [matters, setMatters] = useState<Matter[] | null>(null);
  const [options, setOptions] = useState<MatterOptions | null>(null);
  const [panel, setPanel] = useState<MattersPanel | null>(null);
  const [width, setWidth] = useState(420);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    matterApi.list(query.trim() ? { q: query.trim() } : {}).then(
      (items) => {
        setMatters(items);
        setError(null);
      },
      (err) => setError(messageOf(err)),
    );
  }, [query]);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    matterApi.options().then(setOptions, () => undefined);
  }, []);

  const setTab = (next: string) => {
    window.location.hash = mattersHash(next as MattersTab);
  };
  const saved = () => {
    setPanel(null);
    refresh();
  };

  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Matters & Walls"
      commands={[
        {
          id: "add-matter",
          kind: "action",
          group: "Matters",
          label: "Add matter",
          run: () => setPanel({ kind: "add" }),
        },
        { id: "threads", kind: "action", group: "Go to", label: "Threads", run: onLeave },
      ]}
      sidebar={
        <div className="grid min-w-0 gap-2">
          <Button variant="quiet" size="sm" className="justify-start" onClick={onLeave}>
            Back to threads
          </Button>
          <p className="text-dense text-fg-muted">
            Matters group work by client, and walls decide who may see each one.
          </p>
        </div>
      }
      panel={
        panel && (
          <SidePanel
            title={panel.kind === "matter" ? panel.matter.display : TITLES[panel.kind]}
            width={width}
            onWidthChange={setWidth}
            onClose={() => setPanel(null)}
          >
            {panel.kind === "add" && <AddMatterForm onSaved={saved} />}
            {panel.kind === "import" && <ImportMatters onApplied={refresh} />}
            {panel.kind === "options" && options && (
              <OptionsForm
                options={options}
                onSaved={(next) => {
                  setOptions(next);
                  saved();
                }}
              />
            )}
            {panel.kind === "matter" && (
              <MatterEditor key={panel.matter.id} matter={panel.matter} onSaved={saved} />
            )}
          </SidePanel>
        )
      }
    >
      <main id="main" className="flex min-w-0 flex-1 flex-col overflow-auto p-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="text-title font-semibold">Matters &amp; Walls</h1>
          <div className="ml-auto flex gap-2">
            <Button onClick={() => setPanel({ kind: "add" })}>Add matter</Button>
            <Button variant="quiet" onClick={() => setPanel({ kind: "import" })}>
              Import CSV
            </Button>
            <Button variant="quiet" onClick={() => setPanel({ kind: "options" })}>
              Options
            </Button>
          </div>
        </div>
        {error && (
          <p role="alert" className="mb-4 text-destructive">
            {error}
          </p>
        )}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="matters">Matters</TabsTrigger>
            <TabsTrigger value="walls">Walls</TabsTrigger>
          </TabsList>
          <TabsContent value="matters">
            <MattersTable
              matters={matters}
              query={query}
              onQuery={setQuery}
              onOpen={(matter) => setPanel({ kind: "matter", matter })}
            />
          </TabsContent>
          <TabsContent value="walls">
            {matters === null ? (
              <p className="text-fg-muted">Loading…</p>
            ) : (
              <WallsTab matters={matters} />
            )}
          </TabsContent>
        </Tabs>
      </main>
    </AppShell>
  );
}
