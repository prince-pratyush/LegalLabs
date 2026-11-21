import type { WallCsvPreview, WallEvaluation, WallProviderKind } from "@legallabs/contracts";
import { Button, Field, Input, NativeSelect, toast } from "@legallabs/ui";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type Matter,
  MatterApiError,
  matterApi,
  messageOf,
  type Principal,
  type WallProvider,
  type WallRow,
} from "./api.js";

const PROVIDER_LABEL: Record<WallProviderKind, string> = {
  internal: "Internal (managed here)",
  csv: "CSV upload",
  intapp: "Intapp Walls (not available yet)",
  imanage_spm: "iManage Security Policy Manager (not available yet)",
};

const REASON_TEXT: Record<WallEvaluation["reason"], string> = {
  no_matter: "No matter, so no wall applies.",
  deny: "A deny row matches, and deny always wins.",
  not_allow_listed: "The matter is allow-listed and no allow row matches.",
  allowed: "An allow row on the allow-list matches.",
  open: "The matter is open and nothing denies.",
};

export function WallsTab({ matters }: { matters: Matter[] }) {
  const [matterId, setMatterId] = useState(matters[0]?.id ?? "");
  const [rows, setRows] = useState<WallRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!matterId) return;
    setRows(null);
    matterApi.walls(matterId).then(setRows, (err) => setError(messageOf(err)));
  }, [matterId]);
  useEffect(load, [load]);

  if (matters.length === 0) {
    return <p className="text-fg-muted">Add a matter first, then set its walls here.</p>;
  }

  const remove = async (row: WallRow) => {
    try {
      await matterApi.removeWall(row.id);
      toast.success("Wall row removed");
      load();
    } catch (err) {
      toast.error(messageOf(err));
    }
  };

  return (
    <div className="grid max-w-4xl gap-8">
      <ProviderSelector />
      <section aria-labelledby="rows-heading" className="grid gap-3">
        <h2 id="rows-heading" className="text-section font-semibold">
          Wall rows
        </h2>
        <Field label="Matter">
          {(props) => (
            <NativeSelect
              {...props}
              value={matterId}
              onChange={(e) => setMatterId(e.target.value)}
              className="max-w-md"
            >
              {matters.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display} · {m.matter_name}
                  {m.wall_mode === "allow_list" ? " (allow-listed)" : ""}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {rows === null ? (
          <p className="text-fg-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-fg-muted">No wall rows on this matter.</p>
        ) : (
          <table className="w-full text-ui">
            <thead>
              <tr className="text-left text-fg-muted">
                <th className="py-1">Who</th>
                <th>Effect</th>
                <th>Provider</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-border">
                  <td className="py-1">
                    {row.principal_label} ({row.principal_type})
                  </td>
                  <td>{row.effect}</td>
                  <td>
                    <span className="rounded-sm border border-border px-1 text-caption">
                      {row.provider}
                    </span>
                  </td>
                  <td className="text-right">
                    {row.provider === "internal" && (
                      <Button
                        size="sm"
                        variant="quiet"
                        aria-label={`Remove ${row.effect} for ${row.principal_label}`}
                        onClick={() => void remove(row)}
                      >
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <AddWallRow matterId={matterId} onAdded={load} />
      </section>
      <WallCsvUpload onApplied={load} />
      <EvaluateTool matters={matters} />
    </div>
  );
}

function PrincipalSearch({
  label,
  onPick,
}: {
  label: string;
  onPick: (principal: Principal | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Principal[]>([]);
  const [picked, setPicked] = useState<Principal | null>(null);

  useEffect(() => {
    if (query.trim().length < 2 || picked?.label === query) return;
    let live = true;
    const timer = setTimeout(() => {
      matterApi.principals(query.trim()).then(
        (items) => live && setFound(items),
        () => live && setFound([]),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, picked]);

  return (
    <div className="grid gap-1">
      <Field label={label}>
        {(props) => (
          <Input
            {...props}
            value={query}
            placeholder="Email or group name"
            onChange={(e) => {
              setQuery(e.target.value);
              setPicked(null);
              onPick(null);
            }}
          />
        )}
      </Field>
      {!picked && found.length > 0 && (
        <ul aria-label={`${label} matches`} className="grid rounded-md border border-border">
          {found.map((p) => (
            <li key={p.principal_id}>
              <Button
                variant="quiet"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  setPicked(p);
                  setQuery(p.label);
                  setFound([]);
                  onPick(p);
                }}
              >
                {p.label} ({p.principal_type})
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddWallRow({ matterId, onAdded }: { matterId: string; onAdded: () => void }) {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [effect, setEffect] = useState<"allow" | "deny">("allow");
  const [key, setKey] = useState(0);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!principal) return;
    try {
      await matterApi.addWall({
        matter_id: matterId,
        principal_type: principal.principal_type,
        principal_id: principal.principal_id,
        effect,
      });
      toast.success(`${effect === "allow" ? "Allowed" : "Denied"} ${principal.label}`);
      setPrincipal(null);
      setKey(key + 1);
      onAdded();
    } catch (err) {
      toast.error(messageOf(err));
    }
  };

  return (
    <form onSubmit={add} className="grid max-w-md gap-3 rounded-md border border-border p-4">
      <PrincipalSearch key={key} label="Person or group" onPick={setPrincipal} />
      <Field label="Effect">
        {(props) => (
          <NativeSelect
            {...props}
            value={effect}
            onChange={(e) => setEffect(e.target.value as "allow" | "deny")}
          >
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
          </NativeSelect>
        )}
      </Field>
      <Button type="submit" disabled={!principal} className="justify-self-start">
        Add row
      </Button>
    </form>
  );
}

function WallCsvUpload({ onApplied }: { onApplied: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<WallCsvPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setError(null);
    try {
      setPreview(await matterApi.wallPreview(file));
    } catch (err) {
      // A rejected file still comes back with what couldn't be matched.
      if (err instanceof MatterApiError && err.code === "TOO_MANY_UNRESOLVED") {
        setPreview(err.body as unknown as WallCsvPreview);
      }
      setError(messageOf(err));
    }
  };

  const apply = async () => {
    if (!preview?.token) return;
    try {
      const result = await matterApi.wallApply(preview.token);
      toast.success(
        `Walls updated on ${result.matters} matters: ${result.add} added, ${result.remove} removed`,
      );
      setPreview(null);
      onApplied();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const change = (c: WallCsvPreview["add"][number]) =>
    `${c.matter_display}: ${c.effect} ${c.principal_type} ${c.principal}`;

  return (
    <section aria-labelledby="csv-heading" className="grid gap-3">
      <h2 id="csv-heading" className="text-section font-semibold">
        Walls CSV
      </h2>
      <p className="text-dense text-fg-muted">
        Columns: client_id, matter_number, principal_type, principal, effect. Each matter in the
        file gets exactly the CSV rows listed; rows from other providers are left alone.
      </p>
      <form onSubmit={check} className="flex flex-wrap items-end gap-3">
        <Field label="Walls file">
          {(props) => (
            <Input
              {...props}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
              }}
            />
          )}
        </Field>
        <Button type="submit" disabled={!file}>
          Preview changes
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {preview && (
        <div aria-label="Walls preview" role="region" className="grid gap-2">
          <p>
            {preview.rows} rows over {preview.matters} matters: {preview.add.length} to add,{" "}
            {preview.remove.length} to remove, {preview.unchanged} unchanged,{" "}
            {preview.unresolved.length} unresolved.
          </p>
          <ul className="grid gap-1 text-dense">
            {preview.add.map((c) => (
              <li key={`add-${change(c)}`}>+ {change(c)}</li>
            ))}
            {preview.remove.map((c) => (
              <li key={`remove-${change(c)}`}>− {change(c)}</li>
            ))}
            {preview.unresolved.map((u) => (
              <li key={`line-${u.line}`}>
                Line {u.line}: {u.message}
              </li>
            ))}
          </ul>
          {preview.accepted && preview.token && (
            <Button onClick={apply} className="justify-self-start">
              Apply walls
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function ProviderSelector() {
  const [provider, setProvider] = useState<WallProvider | null>(null);
  useEffect(() => {
    matterApi.provider().then(setProvider, () => undefined);
  }, []);
  if (!provider) return null;

  const change = async (kind: WallProviderKind) => {
    try {
      setProvider(await matterApi.setProvider(kind));
      toast.success(`Wall provider set to ${PROVIDER_LABEL[kind]}`);
    } catch (err) {
      toast.error(messageOf(err));
    }
  };

  return (
    <section aria-labelledby="provider-heading" className="grid max-w-md gap-2">
      <h2 id="provider-heading" className="text-section font-semibold">
        Provider
      </h2>
      <Field
        label="Authoritative provider"
        hint="Internal rows always apply alongside the provider's rows; a deny from either wins."
      >
        {(props) => (
          <NativeSelect
            {...props}
            value={provider.kind}
            onChange={(e) => void change(e.target.value as WallProviderKind)}
          >
            {(Object.keys(PROVIDER_LABEL) as WallProviderKind[]).map((kind) => (
              <option key={kind} value={kind} disabled={!provider.supported.includes(kind)}>
                {PROVIDER_LABEL[kind]}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      {provider.last_sync_at && (
        <p className="text-dense text-fg-muted">
          Last sync {new Date(provider.last_sync_at).toLocaleString()} ({provider.last_status})
        </p>
      )}
    </section>
  );
}

function EvaluateTool({ matters }: { matters: Matter[] }) {
  const [person, setPerson] = useState<Principal | null>(null);
  const [matterId, setMatterId] = useState(matters[0]?.id ?? "");
  const [result, setResult] = useState<WallEvaluation | null>(null);

  const evaluate = async (event: FormEvent) => {
    event.preventDefault();
    if (!person) return;
    try {
      setResult(await matterApi.evaluate(person.principal_id, matterId));
    } catch (err) {
      toast.error(messageOf(err));
    }
  };

  return (
    <section aria-labelledby="evaluate-heading" className="grid max-w-md gap-3">
      <h2 id="evaluate-heading" className="text-section font-semibold">
        Check access
      </h2>
      <form onSubmit={evaluate} className="grid gap-3">
        <PrincipalSearch
          label="Person"
          onPick={(p) => setPerson(p?.principal_type === "user" ? p : null)}
        />
        <Field label="Matter to check">
          {(props) => (
            <NativeSelect {...props} value={matterId} onChange={(e) => setMatterId(e.target.value)}>
              {matters.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Button type="submit" disabled={!person} className="justify-self-start">
          Check
        </Button>
      </form>
      {result && (
        <output className="grid gap-1">
          <strong>{result.allowed ? "Allowed" : "Denied"}</strong>
          <span>{REASON_TEXT[result.reason]}</span>
          <span className="text-dense text-fg-muted">
            {result.matched_rules.length} matching{" "}
            {result.matched_rules.length === 1 ? "row" : "rows"}
          </span>
        </output>
      )}
    </section>
  );
}
