import { PANEL_MIN, SidePanel, SourcesList, StatusText } from "@legallabs/ui";
import { useState } from "react";
import type { LiveCitation } from "./run-state.js";

/** One answer's sources; a flagged one is shown in place, never opened as if it were checked. */
export function SourcesPanel({
  citations,
  activeN,
  unavailable = false,
  onOpen,
  onFlagged,
  onClose,
}: {
  citations: readonly LiveCitation[];
  activeN?: number;
  /** The active source is verified but has no document page or web link to open. */
  unavailable?: boolean;
  onOpen: (n: number) => void;
  onFlagged: (n: number) => void;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(PANEL_MIN);
  const flagged = citations.find((c) => c.n === activeN && c.status !== "ok");
  return (
    <SidePanel title="Sources" onClose={onClose} width={width} onWidthChange={setWidth}>
      <div className="grid gap-4">
        {unavailable && activeN !== undefined && (
          <p role="status" className="text-dense text-fg-muted">
            Source link unavailable for [{activeN}].
          </p>
        )}
        {flagged && (
          <section
            aria-label={`Source ${flagged.n}`}
            className="grid gap-1 rounded-md border border-dashed border-flagged p-3"
          >
            <p className="flex items-baseline gap-2 text-caption">
              <span className="font-semibold tabular-nums">[{flagged.n}]</span>
              <span className="truncate">{flagged.documentName ?? "Unknown document"}</span>
              <StatusText tone="flagged" className="ml-auto">
                Couldn't verify on the page
              </StatusText>
            </p>
            <blockquote className="border-l-2 border-dashed border-flagged pl-2 text-dense">
              {flagged.quote ?? "No quote given"}
            </blockquote>
          </section>
        )}
        <SourcesList
          citations={citations}
          {...(activeN !== undefined ? { activeN } : {})}
          onOpen={onOpen}
          onFlagged={onFlagged}
        />
      </div>
    </SidePanel>
  );
}
