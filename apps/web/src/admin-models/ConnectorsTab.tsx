import { Button, Field, Input, NativeSelect, toast } from "@legallabs/ui";
import { useEffect, useState } from "react";
import { messageOf } from "../api.js";
import {
  type Connector,
  type ConnectorInput,
  connectorsApi,
  type DiscoverResult,
  type ToolPolicy,
} from "./api.js";

const POLICIES: { value: ToolPolicy; label: string }[] = [
  { value: "allow", label: "Always allow" },
  { value: "ask_user", label: "Ask user" },
  { value: "block", label: "Block" },
];

const STATUS: Record<Connector["status"], string> = {
  pending_approval: "Pending approval",
  enabled: "Enabled",
  disabled: "Disabled",
};

type Diff = NonNullable<DiscoverResult["diff"]>;

function DriftBanner({ diff }: { diff: Diff | null }) {
  return (
    <div role="alert" className="grid gap-1 rounded-md border border-flagged p-3 text-ui">
      <p className="font-medium">
        This server's tools changed since you approved it, so it was disabled.
      </p>
      {diff ? (
        <ul className="text-dense">
          <li>Added: {diff.added.join(", ") || "none"}</li>
          <li>Removed: {diff.removed.join(", ") || "none"}</li>
          <li>Changed: {diff.changed.join(", ") || "none"}</li>
        </ul>
      ) : (
        <p className="text-dense">Discover tools again to see what changed, then approve.</p>
      )}
    </div>
  );
}

function ConnectorCard({
  connector,
  onChange,
}: {
  connector: Connector;
  onChange: (c: Connector) => void;
}) {
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (call: Promise<Connector>) => {
    setError(null);
    return call.then(onChange, (err) => setError(messageOf(err)));
  };
  const c = connector;
  const drifted = c.disabled_reason === "CONNECTOR_MANIFEST_CHANGED";

  return (
    <li className="grid gap-3 rounded-md border border-border p-4">
      <section aria-label={`Connector ${c.name}`} className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-section font-semibold">{c.name}</h3>
          <span className="rounded-md border border-border px-2 text-caption">{c.badge}</span>
          <span className="text-caption text-fg-muted">{STATUS[c.status]}</span>
        </div>
        <p className="text-dense text-fg-muted">{c.url}</p>
        {drifted && <DriftBanner diff={diff} />}
        {error && <p role="alert">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="quiet"
            aria-label={`Discover tools for ${c.name}`}
            onClick={() => {
              setError(null);
              connectorsApi.discover(c.id).then(
                (r) => {
                  setDiff(r.diff);
                  onChange(r.connector);
                },
                (err) => setError(messageOf(err)),
              );
            }}
          >
            Discover tools
          </Button>
          <Button
            size="sm"
            aria-label={`Approve ${c.name}`}
            disabled={c.tools.length === 0 || c.status === "enabled"}
            onClick={() => run(connectorsApi.approve(c.id))}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="quiet"
            aria-label={`Disable ${c.name}`}
            disabled={c.status === "disabled"}
            onClick={() => run(connectorsApi.disable(c.id))}
          >
            Disable
          </Button>
        </div>
        {c.tools.length === 0 ? (
          <p className="text-dense text-fg-muted">
            No tools yet. Discover tools, then set a policy for each.
          </p>
        ) : (
          <table className="w-full border-collapse text-ui">
            <caption className="sr-only">Tools of {c.name}</caption>
            <thead>
              <tr className="border-b border-border text-left text-caption text-fg-muted">
                <th scope="col" className="p-2">
                  Tool
                </th>
                <th scope="col" className="p-2">
                  Workspace policy
                </th>
                <th scope="col" className="p-2">
                  My setting
                </th>
              </tr>
            </thead>
            <tbody>
              {c.tools.map((t) => (
                <tr key={t.name} className="border-b border-border">
                  <th scope="row" className="p-2 text-left font-medium">
                    {t.name}
                    <span className="block text-caption font-normal text-fg-muted">
                      {t.description}
                    </span>
                  </th>
                  <td className="p-2">
                    <NativeSelect
                      aria-label={`Policy for ${t.name}`}
                      value={t.policy}
                      onChange={(e) =>
                        run(connectorsApi.setPolicy(c.id, t.name, e.target.value as ToolPolicy))
                      }
                    >
                      {POLICIES.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </td>
                  <td className="p-2">
                    <NativeSelect
                      aria-label={`My setting for ${t.name}`}
                      value={t.user_policy ?? ""}
                      onChange={(e) =>
                        e.target.value &&
                        run(
                          connectorsApi.setMyPolicy(
                            c.id,
                            t.name,
                            e.target.value as "ask_user" | "block",
                          ),
                        )
                      }
                    >
                      <option value="">Workspace default</option>
                      <option value="ask_user">Ask user</option>
                      <option value="block">Block</option>
                    </NativeSelect>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </li>
  );
}

function RegisterForm({ onAdded }: { onAdded: (c: Connector) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<ConnectorInput["auth"]["kind"]>("none");
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    if (!name.trim()) return setError("Enter a name.");
    if (!url.trim().startsWith("https://")) return setError("The URL must start with https://.");
    const auth: ConnectorInput["auth"] | null =
      kind === "none"
        ? { kind }
        : kind === "bearer"
          ? token
            ? { kind, token }
            : null
          : clientId && clientSecret
            ? { kind, client_id: clientId, client_secret: clientSecret }
            : null;
    if (!auth) return setError("Enter the credentials for this auth kind.");
    connectorsApi.create({ name: name.trim(), url: url.trim(), auth }).then(
      (c) => {
        setName("");
        setUrl("");
        setToken("");
        setClientId("");
        setClientSecret("");
        onAdded(c);
        toast.success("Connector registered");
      },
      (err) => setError(messageOf(err)),
    );
  };

  return (
    <section className="grid max-w-2xl gap-3" aria-labelledby="register-heading">
      <h2 id="register-heading" className="text-section font-semibold">
        Register custom MCP server
      </h2>
      <p className="text-dense text-fg-muted">
        Custom servers are not reviewed. Every tool starts blocked until you allow it.
      </p>
      <Field label="Server name">
        {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Server URL">
        {(p) => (
          <Input
            {...p}
            type="url"
            placeholder="https://mcp.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
      </Field>
      <Field label="Auth kind">
        {(p) => (
          <NativeSelect
            {...p}
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
            <option value="oauth_client">OAuth client</option>
          </NativeSelect>
        )}
      </Field>
      {kind === "bearer" && (
        <Field label="Bearer token">
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          )}
        </Field>
      )}
      {kind === "oauth_client" && (
        <>
          <Field label="Client ID">
            {(p) => <Input {...p} value={clientId} onChange={(e) => setClientId(e.target.value)} />}
          </Field>
          <Field label="Client secret">
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="off"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            )}
          </Field>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <Button className="justify-self-start" onClick={submit}>
        Register server
      </Button>
    </section>
  );
}

/** ADM-006: MCP servers, what each tool may do, and the approval gate. */
export function ConnectorsTab() {
  const [items, setItems] = useState<Connector[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    connectorsApi.list().then(setItems, (err) => setError(messageOf(err)));
  }, []);

  if (error) return <p role="alert">{error}</p>;
  if (!items) return <p role="status">Loading connectors</p>;

  const replace = (next: Connector) =>
    setItems((cur) =>
      cur?.some((c) => c.id === next.id)
        ? cur.map((c) => (c.id === next.id ? next : c))
        : [...(cur ?? []), next],
    );

  return (
    <div className="grid gap-8">
      <section className="grid gap-3" aria-labelledby="connectors-heading">
        <h2 id="connectors-heading" className="text-section font-semibold">
          Connectors
        </h2>
        {items.length === 0 ? (
          <p className="text-dense text-fg-muted">No connectors yet.</p>
        ) : (
          <ul className="grid max-w-4xl gap-3" aria-label="Connectors">
            {items.map((c) => (
              <ConnectorCard key={c.id} connector={c} onChange={replace} />
            ))}
          </ul>
        )}
      </section>
      <RegisterForm onAdded={replace} />
    </div>
  );
}
