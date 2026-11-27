import type { FactExtraction, FactFile, FactSkipReason } from "@legallabs/contracts";
import { Button, StatusText, toast } from "@legallabs/ui";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, messageOf, streamRun } from "../api.js";
import { CheckRow } from "../vaults/shared.js";
import { factsApi } from "./api.js";

const select = "h-8 rounded-md border border-control bg-bg-raised px-2 text-ui";
const LIVE = ["queued", "running"];

export const SKIP_REASONS: Record<FactSkipReason, string> = {
  NOT_READY: "still being read in",
  PARSE_FAILED: "couldn't be opened",
  NO_TEXT: "has pages with no readable text",
  ACCESS_LOST: "you can no longer open it",
  MODEL_NOT_ALLOWED: "the matter allows no model for it",
  MODEL_UNAVAILABLE: "no model could read it",
  COST_LIMIT: "the spend limit was reached",
  BAD_OUTPUT: "the model's answer couldn't be used",
  PAGE_TOO_LONG: "a page is too long to read",
  TOO_MANY_PAGES: "too long to read in full",
  TOO_MANY_FACTS: "too many facts to take in one pass",
  FAILED: "couldn't be read",
};

const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

/** What an extraction did, saying plainly what it didn't read. */
export function Coverage({ extraction }: { extraction: FactExtraction }) {
  const live = LIVE.includes(extraction.state);
  const unread = extraction.documents.filter((d) => d.state === "partial" || d.state === "failed");
  const rejected = extraction.rejected_unverified + extraction.rejected_invalid;
  return (
    <div className="grid gap-1 text-dense">
      <StatusText tone={live ? "running" : extraction.complete ? "verified" : "warning"}>
        {live
          ? `Reading: ${extraction.documents_total - extraction.documents_pending} of ${files(extraction.documents_total)}`
          : extraction.complete
            ? `Read all ${files(extraction.documents_total)}`
            : `${extraction.state === "cancelled" ? "Cancelled" : "Incomplete"}: read ${extraction.documents_read} of ${files(extraction.documents_total)} in full`}
      </StatusText>
      <p>
        {extraction.facts_found} facts added
        {rejected > 0 && `, ${rejected} thrown away because their quote couldn't be checked`}.
      </p>
      {unread.length > 0 && (
        <ul aria-label="Not read in full" className="grid gap-0.5 text-fg-muted">
          {unread.map((d) => (
            <li key={d.document_id}>
              {d.name ?? "A file you can no longer open"}:{" "}
              {d.reason ? SKIP_REASONS[d.reason] : "not read"}
              {d.state === "partial" && ` (${d.pages_read} of ${d.pages_total} pages read)`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ExtractPanel({
  spaceId,
  available,
  onFacts,
}: {
  spaceId: string;
  available: FactFile[];
  /** Called when an extraction has added facts. */
  onFacts: () => void;
}) {
  const vaults = [...new Map(available.map((f) => [f.vault_id, f.vault_name]))];
  const [vault, setVault] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [extraction, setExtraction] = useState<FactExtraction | null>(null);
  const chosenVault = vault || (vaults[0]?.[0] ?? "");
  const inVault = available.filter((f) => f.vault_id === chosenVault);
  const live = extraction !== null && LIVE.includes(extraction.state);
  const runId = extraction?.run_id;

  const refresh = useCallback(
    async (run: string) => {
      const next = await factsApi.extraction(spaceId, run);
      setExtraction(next);
      return next;
    },
    [spaceId],
  );

  // Picks up an extraction left running when the page was last open.
  useEffect(() => {
    factsApi.extractions(spaceId).then(
      ([latest]) => (latest ? refresh(latest.run_id) : undefined),
      () => {},
    );
  }, [spaceId, refresh]);

  useEffect(() => {
    if (!runId || !live) return;
    const update = () => {
      refresh(runId).then(
        (next) => next.facts_found > 0 && onFacts(),
        () => {},
      );
    };
    return streamRun(runId, update, { onDrop: update });
  }, [runId, live, refresh, onFacts]);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const { run_id } = await factsApi.extract(
        spaceId,
        chosen.length ? { document_ids: chosen } : { vault_id: chosenVault },
      );
      setChosen([]);
      await refresh(run_id);
    } catch (err) {
      toast.error(messageOf(err));
    }
  };

  return (
    <section aria-labelledby="extract-heading" className="grid gap-2">
      <h2 id="extract-heading" className="text-section font-semibold">
        Extract facts
      </h2>
      {vaults.length === 0 ? (
        <p className="text-dense text-fg-muted">
          Share a vault with this Space to extract facts from its files.
        </p>
      ) : (
        <form onSubmit={start} className="grid gap-2">
          <label className="grid max-w-sm gap-1 text-ui">
            Vault
            <select
              className={select}
              value={chosenVault}
              onChange={(e) => {
                setVault(e.target.value);
                setChosen([]);
              }}
            >
              {vaults.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="grid max-h-48 gap-1 overflow-auto">
            <legend className="text-dense text-fg-muted">
              Choose files, or none to read the whole vault
            </legend>
            {inVault.map((f) => (
              <CheckRow
                key={f.document_id}
                label={f.name}
                {...(f.ready ? {} : { detail: "Not readable yet" })}
                checked={chosen.includes(f.document_id)}
                onChange={(on) =>
                  setChosen((list) =>
                    on ? [...list, f.document_id] : list.filter((id) => id !== f.document_id),
                  )
                }
              />
            ))}
          </fieldset>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={live}>
              {chosen.length ? `Extract from ${files(chosen.length)}` : "Extract from this vault"}
            </Button>
            {live && runId && (
              <Button
                size="sm"
                variant="quiet"
                onClick={() =>
                  api.cancel(runId).then(
                    () => refresh(runId),
                    (err) => toast.error(messageOf(err)),
                  )
                }
              >
                Stop
              </Button>
            )}
          </div>
        </form>
      )}
      {extraction && <Coverage extraction={extraction} />}
    </section>
  );
}
