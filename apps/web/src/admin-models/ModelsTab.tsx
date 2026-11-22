import { Button, Checkbox, Field, Input, toast } from "@legallabs/ui";
import { useEffect, useState } from "react";
import { messageOf } from "../api.js";
import {
  type LocalEndpointInput,
  type ModelConfig,
  type ModelList,
  type ModelPolicy,
  modelsApi,
  type Role,
} from "./api.js";

const id = (m: Pick<ModelConfig, "provider" | "model">) => `${m.provider}/${m.model}`;
const CAPABILITIES = ["chat", "embed", "rerank"] as const;

const roleNames = (ids: string[], roles: Role[]) =>
  ids.length === 0 ? "Nobody" : ids.map((r) => roles.find((x) => x.id === r)?.name ?? r).join(", ");

function RolePicker({
  label,
  roles,
  value,
  onChange,
}: {
  label: string;
  roles: Role[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="grid gap-1">
      <legend className="text-ui font-medium">{label}</legend>
      {roles.length === 0 && <p className="text-dense text-fg-muted">No roles yet.</p>}
      {roles.map((r) => (
        <div key={r.id} className="flex items-center gap-2 text-ui">
          <Checkbox
            aria-label={`${label}: ${r.name}`}
            checked={value.includes(r.id)}
            onCheckedChange={(on) =>
              onChange(on === true ? [...value, r.id] : value.filter((x) => x !== r.id))
            }
          />
          {r.name}
        </div>
      ))}
    </fieldset>
  );
}

function ModelEditor({
  model,
  roles,
  onSaved,
  onClose,
}: {
  model: ModelConfig;
  roles: Role[];
  onSaved: (next: ModelConfig) => void;
  onClose: () => void;
}) {
  const [region, setRegion] = useState(model.region);
  const [zdr, setZdr] = useState(model.zdr);
  const [allowed, setAllowed] = useState(model.enabled_for_roles);
  const [key, setKey] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const name = id(model);
  const fail = (err: unknown) => toast.error(messageOf(err));

  const save = () =>
    modelsApi.patch(model, { region, zdr, enabled_for_roles: allowed }).then((next) => {
      onSaved(next);
      toast.success("Model settings saved");
    }, fail);
  const saveKey = () =>
    modelsApi.saveKey(model, key).then((next) => {
      setKey("");
      onSaved(next);
      toast.success("Key saved");
    }, fail);

  return (
    <section
      className="grid max-w-2xl gap-4 rounded-md border border-border p-4"
      aria-label={`Edit ${name}`}
    >
      <h3 className="text-section font-semibold">Edit {name}</h3>
      <Field label="Region">
        {(p) => <Input {...p} value={region} onChange={(e) => setRegion(e.target.value)} />}
      </Field>
      <div className="flex items-center gap-2 text-ui">
        <Checkbox
          aria-label="Zero data retention"
          checked={zdr}
          onCheckedChange={(on) => setZdr(on === true)}
        />
        Zero data retention
      </div>
      <RolePicker label="Allowed roles" roles={roles} value={allowed} onChange={setAllowed} />
      <div className="flex gap-2">
        <Button onClick={save}>Save settings</Button>
        <Button variant="quiet" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="grid gap-2 border-t border-border pt-4">
        <p className="text-ui font-medium">
          {model.byok_secret_ref ? "Key saved" : "No key"}
          <span className="ml-2 text-caption font-normal text-fg-muted">
            The key is encrypted and can't be shown again.
          </span>
        </p>
        <Field label="API key">
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          )}
        </Field>
        <div className="flex gap-2">
          <Button size="sm" disabled={key.length < 8} onClick={saveKey}>
            Save key
          </Button>
          {model.byok_secret_ref && (
            <Button
              size="sm"
              variant="quiet"
              onClick={() => modelsApi.removeKey(model).then(onSaved, fail)}
            >
              Remove key
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-2 border-t border-border pt-4">
        <Button
          className="justify-self-start"
          variant="quiet"
          onClick={() => modelsApi.test(model).then(setResult, fail)}
        >
          Test connection
        </Button>
        {result && (
          <p role="status" className={result.ok ? "text-verified" : "text-destructive"}>
            {result.ok ? "Works: " : "Failed: "}
            {result.message}
          </p>
        )}
      </div>
    </section>
  );
}

function LocalEndpointForm({ onAdded }: { onAdded: (m: ModelConfig) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [context, setContext] = useState("8192");
  const [caps, setCaps] = useState<LocalEndpointInput["capabilities"]>(["chat"]);
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    setError(null);
    const window = Number.parseInt(context, 10);
    if (!name.trim() || !url.trim() || !(window > 0) || caps.length === 0) {
      setError("Enter a name, a URL, a context window and at least one capability.");
      return;
    }
    modelsApi
      .addLocal({
        name: name.trim(),
        url: url.trim(),
        ...(apiKey ? { api_key: apiKey } : {}),
        context_window: window,
        capabilities: caps,
      })
      .then(
        (m) => {
          setName("");
          setUrl("");
          setApiKey("");
          onAdded(m);
          toast.success("Local endpoint added");
        },
        (err) => setError(messageOf(err)),
      );
  };

  return (
    <section className="grid max-w-2xl gap-3" aria-labelledby="local-heading">
      <h2 id="local-heading" className="text-section font-semibold">
        Add local endpoint
      </h2>
      <p className="text-dense text-fg-muted">
        A model you host yourself. After adding it, open it and use Test connection.
      </p>
      <Field label="Endpoint name">
        {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Endpoint URL">
        {(p) => (
          <Input
            {...p}
            type="url"
            placeholder="https://models.example.com/v1"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
      </Field>
      <Field label="Endpoint API key (optional)">
        {(p) => (
          <Input
            {...p}
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        )}
      </Field>
      <Field label="Context window (tokens)">
        {(p) => (
          <Input
            {...p}
            inputMode="numeric"
            value={context}
            onChange={(e) => setContext(e.target.value)}
          />
        )}
      </Field>
      <fieldset className="flex flex-wrap gap-4">
        <legend className="text-ui font-medium">Capabilities</legend>
        {CAPABILITIES.map((c) => (
          <div key={c} className="flex items-center gap-2 text-ui">
            <Checkbox
              aria-label={`Capability: ${c}`}
              checked={caps.includes(c)}
              onCheckedChange={(on) =>
                setCaps(on === true ? [...caps, c] : caps.filter((x) => x !== c))
              }
            />
            {c}
          </div>
        ))}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <Button className="justify-self-start" onClick={add}>
        Add endpoint
      </Button>
    </section>
  );
}

function PolicyCard({
  policy,
  roles,
  onSaved,
}: {
  policy: ModelPolicy;
  roles: Role[];
  onSaved: (p: ModelPolicy) => void;
}) {
  const [draft, setDraft] = useState(policy);
  return (
    <section
      className="grid max-w-2xl gap-3 rounded-md border border-border p-4"
      aria-labelledby="policy-heading"
    >
      <h2 id="policy-heading" className="text-section font-semibold">
        Workspace model policy
      </h2>
      <div className="flex items-center gap-2 text-ui">
        <Checkbox
          aria-label="Zero-data-retention models only"
          checked={draft.zdr_only}
          onCheckedChange={(on) => setDraft({ ...draft, zdr_only: on === true })}
        />
        Zero-data-retention models only
      </div>
      <Field label="Only models in region" hint="Leave empty to allow any region.">
        {(p) => (
          <Input
            {...p}
            value={draft.region_only ?? ""}
            onChange={(e) => setDraft({ ...draft, region_only: e.target.value.trim() || null })}
          />
        )}
      </Field>
      <RolePicker
        label="Model selector disabled for"
        roles={roles}
        value={draft.selector_disabled_roles}
        onChange={(next) => setDraft({ ...draft, selector_disabled_roles: next })}
      />
      <Button
        className="justify-self-start"
        onClick={() =>
          modelsApi.savePolicy(draft).then(
            (saved) => {
              onSaved(saved);
              toast.success("Policy saved");
            },
            (err) => toast.error(messageOf(err)),
          )
        }
      >
        Save policy
      </Button>
    </section>
  );
}

/** ADM-005: which models the workspace may use, for whom, and with which keys. */
export function ModelsTab() {
  const [data, setData] = useState<ModelList | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([modelsApi.list(), modelsApi.roles()]).then(
      ([list, rs]) => {
        setData(list);
        setRoles(rs);
      },
      (err) => setError(messageOf(err)),
    );
  }, []);

  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p role="status">Loading models</p>;

  const replace = (next: ModelConfig) =>
    setData(
      (d) =>
        d && {
          ...d,
          items: d.items.some((m) => id(m) === id(next))
            ? d.items.map((m) => (id(m) === id(next) ? next : m))
            : [...d.items, next],
        },
    );
  const selected = data.items.find((m) => id(m) === editing);

  return (
    <div className="grid gap-8">
      <section className="grid gap-3" aria-labelledby="models-heading">
        <h2 id="models-heading" className="text-section font-semibold">
          Models
        </h2>
        <table className="w-full max-w-5xl border-collapse text-ui">
          <caption className="sr-only">Models</caption>
          <thead>
            <tr className="border-b border-border text-left text-caption text-fg-muted">
              <th scope="col" className="p-2">
                Model
              </th>
              <th scope="col" className="p-2">
                Enabled
              </th>
              <th scope="col" className="p-2">
                Allowed roles
              </th>
              <th scope="col" className="p-2">
                Data retention
              </th>
              <th scope="col" className="p-2">
                Region
              </th>
              <th scope="col" className="p-2">
                Key
              </th>
              <th scope="col" className="p-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((m) => (
              <tr key={id(m)} className="border-b border-border">
                <th scope="row" className="p-2 text-left font-medium">
                  {id(m)}
                </th>
                <td className="p-2">
                  <Checkbox
                    aria-label={`Enabled: ${id(m)}`}
                    checked={m.enabled}
                    onCheckedChange={(on) =>
                      modelsApi
                        .patch(m, { enabled: on === true })
                        .then(replace, (err) => toast.error(messageOf(err)))
                    }
                  />
                </td>
                <td className="p-2">{roleNames(m.enabled_for_roles, roles)}</td>
                <td className="p-2">{m.zdr ? "ZDR" : "Standard"}</td>
                <td className="p-2">{m.region}</td>
                <td className="p-2">{m.byok_secret_ref ? "Key saved" : "No key"}</td>
                <td className="p-2">
                  <Button
                    size="sm"
                    variant="quiet"
                    aria-label={`Edit ${id(m)}`}
                    onClick={() => setEditing(id(m))}
                  >
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {selected && (
          <ModelEditor
            key={id(selected)}
            model={selected}
            roles={roles}
            onSaved={replace}
            onClose={() => setEditing(null)}
          />
        )}
      </section>
      <LocalEndpointForm
        onAdded={(m) => {
          replace(m);
          setEditing(id(m));
        }}
      />
      <PolicyCard
        policy={data.policy}
        roles={roles}
        onSaved={(policy) => setData({ ...data, policy })}
      />
    </div>
  );
}
