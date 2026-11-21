import { Button } from "@legallabs/ui";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { agentApi } from "./api.js";
import { RunView } from "./RunView.js";
import { goAgents } from "./route.js";

/** A run opened from Run agent or from Activity. */
export function RunPage({ agentId, runId }: { agentId: string; runId: string }) {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    agentApi.get(agentId).then(
      (a) => setTitle(a.title),
      () => setTitle(null),
    );
  }, [agentId]);
  return (
    <div className="grid min-w-0 max-w-3xl content-start gap-4">
      <div>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => goAgents({ page: "agent", agentId, tab: "activity" })}
        >
          <ArrowLeft aria-hidden />
          {title ?? "Agent"}
        </Button>
      </div>
      <h1 className="text-title font-semibold">Run{title ? ` of ${title}` : ""}</h1>
      <RunView runId={runId} />
    </div>
  );
}
