import { buttonStyles, Field, Input, NativeSelect } from "@legallabs/ui";
import { type ReactNode, useState } from "react";
import type { Range } from "./api.js";
import { lastDays } from "./labels.js";

const PRESETS = [
  { id: "30", label: "Past 30 days", days: 30 },
  { id: "90", label: "Past 3 months", days: 90 },
  { id: "180", label: "Past 6 months", days: 180 },
  { id: "365", label: "Past 12 months", days: 365 },
] as const;

/** One range control for everything under it. */
export function RangePicker({ range, onChange }: { range: Range; onChange: (r: Range) => void }) {
  const [preset, setPreset] = useState("30");
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Range">
        {(props) => (
          <NativeSelect
            {...props}
            value={preset}
            onChange={(e) => {
              setPreset(e.target.value);
              const found = PRESETS.find((p) => p.id === e.target.value);
              if (found) onChange(lastDays(found.days));
            }}
          >
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom</option>
          </NativeSelect>
        )}
      </Field>
      {preset === "custom" &&
        (["from", "to"] as const).map((end) => (
          <Field key={end} label={end === "from" ? "From" : "To"}>
            {(props) => (
              <Input
                {...props}
                type="date"
                value={range[end]}
                onChange={(e) => {
                  const next = { ...range, [end]: e.target.value };
                  if (e.target.value && next.from <= next.to) onChange(next);
                }}
              />
            )}
          </Field>
        ))}
    </div>
  );
}

export function Card({
  title,
  csv,
  children,
}: {
  title: string;
  csv?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="grid min-w-0 content-start gap-3 rounded-lg border border-border bg-bg-raised p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-section font-semibold">{title}</h2>
        {csv && (
          <a
            href={csv}
            download
            className={buttonStyles({ variant: "quiet", size: "sm" })}
            aria-label={`Download ${title} as CSV`}
          >
            Download CSV
          </a>
        )}
      </div>
      {children}
    </section>
  );
}

export const Nothing = ({ children }: { children: ReactNode }) => (
  <p className="text-ui text-fg-muted">{children}</p>
);

export function Table({
  label,
  head,
  rows,
}: {
  label: string;
  head: string[];
  rows: { key: string; cells: ReactNode[] }[];
}) {
  return (
    <div className="overflow-auto">
      <table aria-label={label} className="w-full border-collapse text-dense tabular-nums">
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                scope="col"
                className="h-row border-b border-border px-2 text-left font-medium text-fg-muted"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="h-row border-b border-border">
              {row.cells.map((cell, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells are fixed by their column
                <td key={i} className="px-2">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A single-series column chart: one hue, bars from a zero baseline, the hovered value read
 * out above, and the same numbers as a table for anyone who can't use the bars.
 */
export function Columns({
  label,
  unit,
  points,
}: {
  label: string;
  unit: string;
  points: { key: string; value: number }[];
}) {
  const [at, setAt] = useState<number | null>(null);
  const max = Math.max(...points.map((p) => p.value), 1);
  const shown = at === null ? null : points[at];
  return (
    <div className="grid min-w-0 gap-1">
      <p className="text-caption text-fg-muted">
        {shown ? `${shown.key}: ${shown.value} ${unit}` : `Peak ${max} ${unit}`}
      </p>
      <div
        role="img"
        aria-label={`${label}, ${points.length} periods, peak ${max} ${unit}`}
        className="flex h-32 items-end gap-0.5 border-b border-border"
        onPointerLeave={() => setAt(null)}
      >
        {points.map((p, i) => (
          <div
            key={p.key}
            title={`${p.key}: ${p.value} ${unit}`}
            className="flex h-full min-w-0 flex-1 items-end justify-center"
            onPointerEnter={() => setAt(i)}
          >
            <div
              className="w-full max-w-6 rounded-t-sm bg-accent"
              style={{ height: `${(p.value / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-caption text-fg-muted">
        <span>{points[0]?.key}</span>
        <span>{points.length > 1 ? points.at(-1)?.key : null}</span>
      </div>
      <details>
        <summary className="cursor-pointer text-caption text-fg-muted">Show as table</summary>
        <div className="max-h-60 overflow-auto">
          <Table
            label={`${label} data`}
            head={["Period", unit]}
            rows={points.map((p) => ({ key: p.key, cells: [p.key, p.value] }))}
          />
        </div>
      </details>
    </div>
  );
}

/** A horizontal bar beside its own number, for shares. */
export const Bar = ({ share }: { share: number }) => (
  <div aria-hidden className="h-2 w-full min-w-16">
    <div
      className="h-full rounded-r-sm bg-accent"
      style={{ width: `${Math.min(100, Math.max(0, share))}%` }}
    />
  </div>
);
