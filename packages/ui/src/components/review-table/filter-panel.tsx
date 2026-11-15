import { Flag } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "../button.js";
import { Checkbox } from "../checkbox.js";
import { Field, Input } from "../field.js";
import { type CellStatus, FLAG_CLASS, FLAG_COLORS, type FlagColor, flagName } from "./types.js";

/** One column's filter; matches the API's CellCondition minus column_id. */
export interface ColumnFilter {
  status?: CellStatus[];
  flag?: FlagColor[];
  verified?: boolean;
  locked?: boolean;
  contains?: string;
}

/** Like ColumnFilter, but a part can be set back to undefined while editing. */
type Draft = { [K in keyof ColumnFilter]?: ColumnFilter[K] | undefined };

const STATUS_NAMES: [CellStatus, string][] = [
  ["done", "Answered"],
  ["null", "No answer"],
  ["error", "Error"],
  ["pending", "Not run"],
  ["running", "Running"],
  ["stale", "Stale"],
];

const toggle = <T,>(list: T[] | undefined, item: T) => {
  const next = list?.includes(item) ? list.filter((x) => x !== item) : [...(list ?? []), item];
  return next.length ? next : undefined;
};

/** Drops empty parts, so an empty filter is null rather than a condition matching all. */
export function cleanFilter(filter: Draft): ColumnFilter | null {
  const out: ColumnFilter = {};
  if (filter.status?.length) out.status = filter.status;
  if (filter.flag?.length) out.flag = filter.flag;
  if (filter.verified !== undefined) out.verified = filter.verified;
  if (filter.locked !== undefined) out.locked = filter.locked;
  if (filter.contains?.trim()) out.contains = filter.contains.trim();
  return Object.keys(out).length ? out : null;
}

function TriState({
  legend,
  value,
  onChange,
  yes,
  no,
}: {
  legend: string;
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
  yes: string;
  no: string;
}) {
  const options: [string, boolean | undefined][] = [
    ["Any", undefined],
    [yes, true],
    [no, false],
  ];
  return (
    <fieldset className="flex flex-wrap gap-3">
      <legend className="mb-1 w-full text-ui font-medium">{legend}</legend>
      {options.map(([name, v]) => (
        <label key={name} className="flex items-center gap-1 text-dense">
          <input type="radio" name={legend} checked={value === v} onChange={() => onChange(v)} />
          {name}
        </label>
      ))}
    </fieldset>
  );
}

/** Filter one column by status, flag, verification, lock and value (RVT-005). */
export function FilterPanel({
  columnLabel,
  value,
  onApply,
}: {
  columnLabel: string;
  value: ColumnFilter | null;
  onApply: (filter: ColumnFilter | null) => void;
}) {
  const [draft, setDraft] = useState<Draft>(value ?? {});
  const set = (patch: Draft) => setDraft((d) => ({ ...d, ...patch }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply(cleanFilter(draft));
  };

  return (
    <form onSubmit={submit} aria-label={`Filter ${columnLabel}`} className="grid gap-3">
      <Field label="Value contains">
        {(props) => (
          <Input
            {...props}
            value={draft.contains ?? ""}
            maxLength={200}
            onChange={(e) => set({ contains: e.target.value })}
          />
        )}
      </Field>
      <fieldset className="grid grid-cols-2 gap-1">
        <legend className="mb-1 text-ui font-medium">Status</legend>
        {STATUS_NAMES.map(([status, name]) => (
          <span key={status} className="flex items-center gap-1 text-dense">
            <Checkbox
              id={`filter-status-${status}`}
              checked={draft.status?.includes(status) ?? false}
              onCheckedChange={() => set({ status: toggle(draft.status, status) })}
            />
            <label htmlFor={`filter-status-${status}`}>{name}</label>
          </span>
        ))}
      </fieldset>
      <fieldset className="grid grid-cols-3 gap-1">
        <legend className="mb-1 text-ui font-medium">Flag</legend>
        {FLAG_COLORS.map((color) => (
          <span key={color} className="flex items-center gap-1 text-dense">
            <Checkbox
              id={`filter-flag-${color}`}
              checked={draft.flag?.includes(color) ?? false}
              onCheckedChange={() => set({ flag: toggle(draft.flag, color) })}
            />
            <label htmlFor={`filter-flag-${color}`} className="flex items-center gap-1">
              <Flag
                aria-hidden
                className={`size-3.5 ${FLAG_CLASS[color].text}`}
                fill="currentColor"
              />
              {flagName(color)}
            </label>
          </span>
        ))}
      </fieldset>
      <TriState
        legend="Verified"
        yes="Verified"
        no="Not verified"
        value={draft.verified}
        onChange={(verified) => set({ verified })}
      />
      <TriState
        legend="Locked"
        yes="Locked"
        no="Unlocked"
        value={draft.locked}
        onChange={(locked) => set({ locked })}
      />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setDraft({});
            onApply(null);
          }}
        >
          Clear
        </Button>
        <Button type="submit">Apply filter</Button>
      </div>
    </form>
  );
}
