import {
  HORIZON_LIMITS,
  HORIZON_SOURCES,
  type HorizonScan,
  HorizonScanCreate,
} from "@legallabs/contracts";
import { Button, Checkbox, Field, Input, NativeSelect, Textarea } from "@legallabs/ui";
import { type FormEvent, useId, useState } from "react";
import { messageOf } from "../api.js";
import { horizonApi } from "./api.js";
import { goHorizon } from "./route.js";

const JURISDICTIONS = ["US", "UK"] as const;

const day = (ago: number, from = Date.now()) =>
  new Date(from - ago * 86_400_000).toISOString().slice(0, 10);

const split = (text: string) => [
  ...new Set(
    text
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  ),
];

function Choices({
  legend,
  options,
  chosen,
  onChange,
}: {
  legend: string;
  options: readonly { id: string; name: string }[];
  chosen: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const id = useId();
  return (
    <fieldset className="grid gap-1">
      <legend className="font-medium">{legend}</legend>
      {options.map((option) => (
        <label key={option.id} htmlFor={`${id}-${option.id}`} className="flex items-center gap-2">
          <Checkbox
            id={`${id}-${option.id}`}
            checked={chosen.includes(option.id)}
            onCheckedChange={(on) =>
              onChange(on === true ? [...chosen, option.id] : chosen.filter((c) => c !== option.id))
            }
          />
          {option.name}
        </label>
      ))}
    </fieldset>
  );
}

/** A scan filled in by hand: a new one, or changes to one. */
export function ScanForm({ scan }: { scan?: HorizonScan }) {
  const [name, setName] = useState(scan?.name ?? "");
  const [purpose, setPurpose] = useState(scan?.purpose ?? "");
  const [jurisdictions, setJurisdictions] = useState<string[]>(scan?.jurisdictions ?? []);
  const [sources, setSources] = useState<string[]>(scan?.sources ?? []);
  const [topics, setTopics] = useState(scan?.topics.join(", ") ?? "");
  const [industries, setIndustries] = useState(scan?.industries.join(", ") ?? "");
  const [from, setFrom] = useState(scan?.from_date ?? day(7));
  const [floor, setFloor] = useState(scan?.relevance_floor ?? "low");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const made = scan ? Date.parse(scan.created_at) : Date.now();

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = HorizonScanCreate.safeParse({
      name: name.trim(),
      purpose: purpose.trim(),
      jurisdictions,
      industries: split(industries),
      topics: split(topics),
      sources,
      from_date: from,
      relevance_floor: floor,
    });
    if (!parsed.success) {
      setError("Give a name, a purpose, a start date and at least one source.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = scan
        ? await horizonApi.update(scan.id, parsed.data)
        : await horizonApi.create(parsed.data);
      goHorizon({ page: "scan", scanId: saved.id });
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  return (
    <form className="grid max-w-2xl content-start gap-4" onSubmit={save} noValidate>
      <h1 className="text-title font-semibold">{scan ? "Change scan" : "New scan"}</h1>
      <Field label="Name">
        {(props) => (
          <Input
            {...props}
            value={name}
            maxLength={HORIZON_LIMITS.name_chars}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Field label="Purpose" hint="What you are watching for. Only you can see it.">
        {(props) => (
          <Textarea
            {...props}
            rows={4}
            value={purpose}
            maxLength={HORIZON_LIMITS.purpose_chars}
            onChange={(e) => setPurpose(e.target.value)}
          />
        )}
      </Field>
      <Choices legend="Sources" options={HORIZON_SOURCES} chosen={sources} onChange={setSources} />
      <Choices
        legend="Jurisdictions"
        options={JURISDICTIONS.map((j) => ({ id: j, name: j }))}
        chosen={jurisdictions}
        onChange={setJurisdictions}
      />
      <Field label="Topics" hint="Separate with commas.">
        {(props) => <Input {...props} value={topics} onChange={(e) => setTopics(e.target.value)} />}
      </Field>
      <Field label="Industries" hint="Separate with commas.">
        {(props) => (
          <Input {...props} value={industries} onChange={(e) => setIndustries(e.target.value)} />
        )}
      </Field>
      <Field label="Start from" hint="At most 28 days before the scan was made.">
        {(props) => (
          <Input
            {...props}
            type="date"
            min={day(HORIZON_LIMITS.from_days, made)}
            max={day(0)}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        )}
      </Field>
      <Field label="Collapse items below">
        {(props) => (
          <NativeSelect
            {...props}
            value={floor}
            onChange={(e) => setFloor(e.target.value as HorizonScan["relevance_floor"])}
          >
            <option value="low">Show everything</option>
            <option value="medium">Medium relevance</option>
            <option value="high">High relevance</option>
          </NativeSelect>
        )}
      </Field>
      {error && <p role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {scan ? "Save changes" : "Create scan"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => goHorizon(scan ? { page: "scan", scanId: scan.id } : { page: "list" })}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
