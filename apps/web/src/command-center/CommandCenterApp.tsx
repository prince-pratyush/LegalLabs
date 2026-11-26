import { Tabs, TabsContent, TabsList, TabsTrigger } from "@legallabs/ui";
import { useState } from "react";
import { AdminShell } from "../admin/AdminShell.js";
import { useHash } from "../router.js";
import { AnalyticsTab } from "./AnalyticsTab.js";
import { lastDays } from "./labels.js";
import { OutcomesTab } from "./OutcomesTab.js";
import { OverviewTab } from "./OverviewTab.js";
import { RangePicker } from "./parts.js";
import { type CommandCenterTab, commandCenterHash, parseCommandCenterRoute } from "./route.js";

/** Admin: how the workspace uses the product (CMD-001..003). */
export function CommandCenterApp({ onLeave }: { onLeave: () => void }) {
  const tab = parseCommandCenterRoute(useHash())?.tab ?? "overview";
  const [range, setRange] = useState(() => lastDays(30));
  return (
    <AdminShell
      page="command-center"
      title="Command Center"
      note="Counts and labels only: no prompt text or file names are recorded here."
      onLeave={onLeave}
    >
      <Tabs
        value={tab}
        onValueChange={(next) => {
          window.location.hash = commandCenterHash(next as CommandCenterTab);
        }}
      >
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
          <TabsTrigger value="outcomes">Outcomes</TabsTrigger>
        </TabsList>
        <div className="mt-4">
          <RangePicker range={range} onChange={setRange} />
        </div>
        <TabsContent value="overview" className="mt-4">
          <OverviewTab range={range} />
        </TabsContent>
        <TabsContent value="analytics" className="mt-4">
          <AnalyticsTab range={range} />
        </TabsContent>
        <TabsContent value="outcomes" className="mt-4">
          <OutcomesTab range={range} />
        </TabsContent>
      </Tabs>
    </AdminShell>
  );
}
