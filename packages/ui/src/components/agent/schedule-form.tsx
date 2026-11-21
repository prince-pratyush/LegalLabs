import { nextScheduledRun, type Schedule } from "@legallabs/contracts";
import { type FormEvent, useId, useState } from "react";
import { Button } from "../button.js";
import { Checkbox } from "../checkbox.js";
import { Input, Label, Textarea } from "../field.js";
import { StatusText } from "../status.js";
import { formatWhen, selectStyles } from "./types.js";

export type ScheduleValue = {
  rule: "every_n_days" | "weekly";
  n: number;
  /** 0 is Sunday. */
  weekdays: number[];
  timeLocal: string;
  tz: string;
  matterId: string | null;
  email: boolean;
  inputs: string;
  anchorDate?: string;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The schedule as the API takes it. */
export function toSchedule(value: ScheduleValue): Schedule {
  const inputs = value.inputs.trim();
  return {
    rule: value.rule,
    params: {
      ...(value.rule === "every_n_days" ? { n: value.n } : { weekdays: value.weekdays }),
      ...(inputs ? { inputs } : {}),
    },
    time_local: value.timeLocal,
    tz: value.tz,
    ...(value.matterId ? { matter_id: value.matterId } : {}),
    email: value.email,
    ...(value.anchorDate ? { anchor_date: value.anchorDate } : {}),
  };
}

const today = (tz: string) => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};

/** The next few fires, so a wrong time zone or weekday shows before it is saved. */
export function upcoming(value: ScheduleValue, count = 3, from = new Date()): Date[] {
  const schedule = toSchedule({ ...value, anchorDate: value.anchorDate ?? today(value.tz) });
  const out: Date[] = [];
  let after = from;
  for (let i = 0; i < count; i += 1) {
    let next: Date | null = null;
    try {
      next = nextScheduledRun(schedule, after);
    } catch {
      next = null;
    }
    if (!next) break;
    out.push(next);
    after = next;
  }
  return out;
}

export const blankSchedule = (tz: string): ScheduleValue => ({
  rule: "weekly",
  n: 7,
  weekdays: [1],
  timeLocal: "09:00",
  tz,
  matterId: null,
  email: false,
  inputs: "",
});

/** One schedule per person per agent; scheduled runs can't ask questions, so inputs are fixed. */
export function ScheduleForm({
  initial,
  zones,
  matters = [],
  state,
  busy = false,
  error,
  onSave,
  onRemove,
}: {
  initial: ScheduleValue;
  zones: readonly string[];
  matters?: readonly { id: string; name: string }[];
  /** The saved schedule's state; null before the first save. */
  state?: { paused: boolean; reason: string | null; nextRunAt: string | null } | null;
  busy?: boolean;
  error?: string | null;
  onSave: (value: ScheduleValue) => void;
  onRemove?: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<ScheduleValue>) => setValue((v) => ({ ...v, ...patch }));
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(value.timeLocal);
  const next = valid ? upcoming(value) : [];
  const zoneList = zones.includes(value.tz) ? zones : [value.tz, ...zones];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.rule === "every_n_days" && !(value.n >= 1 && value.n <= 90))
      return setProblem("Choose between 1 and 90 days.");
    if (value.rule === "weekly" && value.weekdays.length === 0)
      return setProblem("Choose at least one day.");
    if (!valid) return setProblem("Enter a time as HH:MM.");
    setProblem(null);
    onSave(value);
  };

  return (
    <form onSubmit={submit} aria-label="Schedule" className="grid gap-4">
      {state && (
        <div className="grid gap-1 rounded-md border border-border p-3">
          {state.paused ? (
            <StatusText tone="warning">
              Paused{state.reason ? `: ${state.reason}` : ""}. Save to resume.
            </StatusText>
          ) : (
            <StatusText tone="verified">Active</StatusText>
          )}
          {!state.paused && state.nextRunAt && (
            <p className="text-dense text-fg-muted">
              Next run {formatWhen(state.nextRunAt, value.tz)}
            </p>
          )}
        </div>
      )}
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-ui font-medium">Frequency</legend>
        <label className="flex items-center gap-2 text-ui">
          <input
            type="radio"
            name={`${id}-rule`}
            checked={value.rule === "weekly"}
            onChange={() => set({ rule: "weekly" })}
          />
          Weekly on chosen days
        </label>
        <label className="flex items-center gap-2 text-ui">
          <input
            type="radio"
            name={`${id}-rule`}
            checked={value.rule === "every_n_days"}
            onChange={() => set({ rule: "every_n_days" })}
          />
          Every few days
        </label>
      </fieldset>
      {value.rule === "weekly" ? (
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-ui font-medium">Days</legend>
          <div className="flex flex-wrap gap-1">
            {DAYS.map((day, n) => {
              const on = value.weekdays.includes(n);
              return (
                <Button
                  key={day}
                  size="sm"
                  variant={on ? "secondary" : "quiet"}
                  aria-pressed={on}
                  aria-label={DAY_NAMES[n]}
                  onClick={() =>
                    set({
                      weekdays: on
                        ? value.weekdays.filter((d) => d !== n)
                        : [...value.weekdays, n].sort(),
                    })
                  }
                >
                  {day}
                </Button>
              );
            })}
          </div>
        </fieldset>
      ) : (
        <div className="grid gap-1">
          <Label htmlFor={`${id}-n`}>Every how many days</Label>
          <Input
            id={`${id}-n`}
            type="number"
            min={1}
            max={90}
            value={Number.isFinite(value.n) ? value.n : ""}
            onChange={(e) => set({ n: e.target.valueAsNumber })}
            className="w-24"
          />
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-time`}>Time</Label>
          <Input
            id={`${id}-time`}
            type="time"
            value={value.timeLocal}
            onChange={(e) => set({ timeLocal: e.target.value })}
            className="w-32"
          />
        </div>
        <div className="grid min-w-0 flex-1 gap-1">
          <Label htmlFor={`${id}-tz`}>Time zone</Label>
          <select
            id={`${id}-tz`}
            className={selectStyles}
            value={value.tz}
            onChange={(e) => set({ tz: e.target.value })}
          >
            {zoneList.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${id}-matter`}>Matter (optional)</Label>
        <select
          id={`${id}-matter`}
          className={selectStyles}
          value={value.matterId ?? ""}
          onChange={(e) => set({ matterId: e.target.value || null })}
        >
          <option value="">No matter</option>
          {matters.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${id}-inputs`}>Inputs</Label>
        <Textarea
          id={`${id}-inputs`}
          aria-describedby={`${id}-inputs-hint`}
          value={value.inputs}
          maxLength={5000}
          onChange={(e) => set({ inputs: e.target.value })}
        />
        <p id={`${id}-inputs-hint`} className="text-caption text-fg-muted">
          Scheduled runs can't ask questions, so give anything the agent would ask for here.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-email`}
          checked={value.email}
          onCheckedChange={(on) => set({ email: on === true })}
        />
        <Label htmlFor={`${id}-email`}>Email me the results</Label>
      </div>
      {next.length > 0 && (
        <section aria-label="Next runs" className="grid gap-0.5">
          <p className="text-dense font-medium">Next runs</p>
          <ul className="text-dense text-fg-muted tabular-nums">
            {next.map((d) => (
              <li key={d.toISOString()}>{formatWhen(d.toISOString(), value.tz)}</li>
            ))}
          </ul>
        </section>
      )}
      {(problem || error) && (
        <p role="alert" className="text-dense text-destructive">
          {problem ?? error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {state ? "Save schedule" : "Schedule"}
        </Button>
        {state && onRemove && (
          <Button variant="secondary" disabled={busy} onClick={onRemove}>
            Remove schedule
          </Button>
        )}
      </div>
    </form>
  );
}
