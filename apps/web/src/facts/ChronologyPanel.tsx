import type { ChronologyStyle } from "@legallabs/contracts";
import { Button, toast } from "@legallabs/ui";
import { useState } from "react";
import { messageOf } from "../api.js";
import { navigate, paths } from "../router.js";
import { CheckRow } from "../vaults/shared.js";
import { type FactFilter, factsApi } from "./api.js";

const select = "h-8 rounded-md border border-control bg-bg-raised px-2 text-ui";

/** Turns the facts in view into a chronology: a thread draft, or a Word or Excel file. */
export function ChronologyPanel({ spaceId, filter }: { spaceId: string; filter: FactFilter }) {
  const [style, setStyle] = useState<ChronologyStyle>("table");
  const [disputed, setDisputed] = useState(false);
  const [busy, setBusy] = useState(false);
  const choice = { style, include_disputed: disputed };

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const draft = () =>
    run(async () => {
      const made = await factsApi.generate(spaceId, filter, choice);
      if (made.left_out) {
        toast.error(`${made.left_out} facts were left out: their quotes couldn't be checked.`);
      }
      navigate(paths.thread(made.thread_id));
    });

  return (
    <section aria-labelledby="chronology-heading" className="grid gap-2">
      <h2 id="chronology-heading" className="text-section font-semibold">
        Chronology
      </h2>
      <p className="text-dense text-fg-muted">
        Uses the names, issues and dates chosen above. Rejected facts are never included, and the
        status and file filters don't apply.
      </p>
      <label className="grid max-w-xs gap-1 text-ui">
        Layout
        <select
          className={select}
          value={style}
          onChange={(e) => setStyle(e.target.value as ChronologyStyle)}
        >
          <option value="table">Table</option>
          <option value="narrative">Narrative</option>
        </select>
      </label>
      <CheckRow label="Include disputed facts" checked={disputed} onChange={setDisputed} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={draft}>
          Draft in a thread
        </Button>
        {(["docx", "xlsx"] as const).map((format) => (
          <Button
            key={format}
            size="sm"
            variant="quiet"
            disabled={busy}
            onClick={() => run(() => factsApi.export(spaceId, format, filter, choice))}
          >
            {format === "docx" ? "Download Word" : "Download Excel"}
          </Button>
        ))}
      </div>
    </section>
  );
}
