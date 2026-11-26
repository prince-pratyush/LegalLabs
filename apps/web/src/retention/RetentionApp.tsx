import { Tabs, TabsContent, TabsList, TabsTrigger } from "@legallabs/ui";
import { AdminShell } from "../admin/AdminShell.js";
import { useHash } from "../router.js";
import { BinTab } from "./BinTab.js";
import { HoldsTab } from "./HoldsTab.js";
import { PoliciesTab } from "./PoliciesTab.js";
import { parseRetentionRoute, type RetentionTab, retentionHash } from "./route.js";

/** Admin: how long content is kept, what is held, and what can still be brought back (ADM-004). */
export function RetentionApp({ onLeave }: { onLeave: () => void }) {
  const tab = parseRetentionRoute(useHash())?.tab ?? "policies";
  return (
    <AdminShell
      page="retention"
      title="Retention"
      note="Policy and hold changes may ask for your second factor again."
      onLeave={onLeave}
    >
      <Tabs
        value={tab}
        onValueChange={(next) => {
          window.location.hash = retentionHash(next as RetentionTab);
        }}
      >
        <TabsList>
          <TabsTrigger value="policies">Policies</TabsTrigger>
          <TabsTrigger value="holds">Legal holds</TabsTrigger>
          <TabsTrigger value="bin">Recycle bin</TabsTrigger>
        </TabsList>
        <TabsContent value="policies" className="mt-4">
          <PoliciesTab />
        </TabsContent>
        <TabsContent value="holds" className="mt-4">
          <HoldsTab />
        </TabsContent>
        <TabsContent value="bin" className="mt-4">
          <BinTab />
        </TabsContent>
      </Tabs>
    </AdminShell>
  );
}
