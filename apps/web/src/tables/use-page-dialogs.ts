import type { Column } from "@legallabs/contracts";
import { useState } from "react";

export type Panel =
  | { kind: "builder" }
  | { kind: "filter"; columnId: string }
  | { kind: "prompt"; columnId: string }
  | { kind: "sync" };

/** Which side panel, run dialog, export dialog or add-column popover is open. */
export function usePageDialogs() {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [run, setRun] = useState<{ column: Column; rerun: boolean } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [adding, setAdding] = useState(false);
  return { panel, setPanel, run, setRun, exporting, setExporting, adding, setAdding };
}
