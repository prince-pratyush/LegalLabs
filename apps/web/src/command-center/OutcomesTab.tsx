import { Button, Input } from "@legallabs/ui";
import { type FormEvent, useState } from "react";
import { messageOf, Panel, useLoad } from "../admin/load.js";
import { type Baseline, centerApi, type Outcomes, type Range } from "./api.js";
import { Freshness } from "./DataState.js";
import { NOT_RECORDED, UNRECORDED_WORKFLOWS, WORKFLOW_LABEL } from "./labels.js";
import { Card, Nothing, Table } from "./parts.js";

const duration = (seconds: number | null) => {
  if (seconds === null) return NOT_RECORDED;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
};

export function OutcomesTab({ range }: { range: Range }) {
  const state = useLoad(() => centerApi.outcomes(range), [range.from, range.to]);
  return (
    <div className="grid gap-4">
      <Panel state={state}>
        {(data) => (
          <>
            <Freshness dataAsOf={data.dataAsOf} message={data.message} onRefreshed={state.reload} />
            {data.state === "ready" && <Results data={data} range={range} />}
          </>
        )}
      </Panel>
      <Baselines />
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="grid content-start gap-1 rounded-lg border border-border bg-bg-raised p-4">
      <dt className="text-dense text-fg-muted">{label}</dt>
      <dd className="text-title font-semibold">{value}</dd>
      {note && <dd className="text-caption text-fg-muted">{note}</dd>}
    </div>
  );
}

function Results({ data, range }: { data: Outcomes; range: Range }) {
  const done = data.workflows.length > 0;
  const { rate, verified, flagged } = data.citations;
  return (
    <>
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          label="Hours saved"
          value={done ? data.hoursSaved : "No completions"}
          note={done ? "Completions times your baselines" : "Nothing was completed in this range"}
        />
        <Tile
          label="Contracts reviewed"
          value={data.contractsReviewed > 0 ? data.contractsReviewed : "None recorded"}
        />
        <Tile
          label="Citations verified"
          value={rate === null ? "None checked" : `${Math.round(rate * 100)}%`}
          {...(rate === null ? {} : { note: `${verified} verified, ${flagged} flagged` })}
        />
        <Tile
          label="Requests resolved"
          value={NOT_RECORDED}
          note="Intake does not record completions yet"
        />
      </dl>
      <Card title="Completions by workflow" csv={centerApi.csvUrl("outcomes", { ...range })}>
        {done ? (
          <Table
            label="Completions by workflow"
            head={["Workflow", "Completions", "Hours saved", "Median turnaround"]}
            rows={data.workflows.map((w) => ({
              key: w.workflow_type,
              cells: [
                WORKFLOW_LABEL[w.workflow_type] ?? w.workflow_type,
                w.count,
                w.hours_saved,
                duration(w.turnaround_p50_seconds),
              ],
            }))}
          />
        ) : (
          <Nothing>No completions recorded in this range.</Nothing>
        )}
        <p className="text-dense text-fg-muted">{data.methodology}</p>
      </Card>
    </>
  );
}

function Baselines() {
  const state = useLoad(centerApi.baselines, []);
  return (
    <Card title="Baselines">
      <p className="text-dense text-fg-muted">
        Hours saved per completion. Changing one needs configuration access, is audited, and applies
        from then on; past completions keep the baseline they had.
      </p>
      <Panel state={state}>
        {(rows) => (
          <ul className="grid">
            {rows.map((row) => (
              <BaselineRow
                key={`${row.workflow_type}:${row.hours_per_completion}:${row.note}`}
                row={row}
                onSaved={state.reload}
              />
            ))}
          </ul>
        )}
      </Panel>
    </Card>
  );
}

function BaselineRow({ row, onSaved }: { row: Baseline; onSaved: () => void }) {
  const [hours, setHours] = useState(String(row.hours_per_completion));
  const [note, setNote] = useState(row.note);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = WORKFLOW_LABEL[row.workflow_type] ?? row.workflow_type;
  const value = Number(hours);
  const valid = hours.trim() !== "" && value >= 0 && value <= 1000;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    centerApi
      .setBaseline(row.workflow_type, value, note)
      .then(onSaved, (e: unknown) => setError(messageOf(e)))
      .finally(() => setBusy(false));
  };
  return (
    <li className="border-b border-border py-2">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <span className="w-56">
          {name}
          <span className="block text-caption text-fg-muted">
            {row.cap_hours ? `Per row, up to ${row.cap_hours} hours. ` : ""}
            {UNRECORDED_WORKFLOWS.has(row.workflow_type) ? "Completions are not recorded yet." : ""}
          </span>
        </span>
        <Input
          type="number"
          step="any"
          min={0}
          max={1000}
          className="w-24"
          aria-label={`Hours for ${name}`}
          value={hours}
          onChange={(e) => setHours(e.target.value)}
        />
        <Input
          className="max-w-xs"
          aria-label={`Note for ${name}`}
          placeholder="Note"
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          aria-label={`Save ${name}`}
          disabled={busy || !valid || (value === row.hours_per_completion && note === row.note)}
        >
          Save
        </Button>
        <span className="text-caption text-fg-muted">{row.is_default ? "Default" : "Yours"}</span>
        {error && (
          <p role="alert" className="w-full text-destructive">
            {error}
          </p>
        )}
      </form>
    </li>
  );
}
