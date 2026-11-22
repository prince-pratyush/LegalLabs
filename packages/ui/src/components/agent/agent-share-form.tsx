import { Clock, Globe, User, Users, X } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Button } from "../button.js";
import { Input, Label } from "../field.js";
import { Skeleton, StatusText } from "../status.js";
import { ACCESS_LABEL, type AccessLevel, LEVEL_OPTIONS, selectStyles } from "./types.js";

export type AgentPrincipalType = "user" | "group" | "space" | "workspace";

export type AgentGrant = {
  id: string;
  principalType: AgentPrincipalType;
  label: string;
  level: AccessLevel;
};

export type AgentShareRequest = AgentGrant & {
  status: "pending" | "accepted" | "denied";
  reason: string | null;
};

export type PrincipalCandidate = {
  principalType: "user" | "group";
  principalId: string;
  label: string;
};

export type ShareTarget = {
  principalType: AgentPrincipalType;
  principalId?: string;
  level: AccessLevel;
};

const ICON = { user: User, group: Users, space: Users, workspace: Globe } as const;

/** Who can run, view, edit or fully manage an agent; some shares wait for an approver. */
export function AgentShareForm({
  grants,
  requests,
  search,
  policy,
  busy = false,
  error,
  notice,
  onAdd,
  onRemove,
}: {
  grants: readonly AgentGrant[];
  requests: readonly AgentShareRequest[];
  search: (query: string) => Promise<PrincipalCandidate[]>;
  /** Which kinds of share wait for an admin, said up front. */
  policy?: { individual: boolean; group: boolean; workspace: boolean };
  busy?: boolean;
  error?: string | null;
  /** Said after a share, e.g. that it is waiting for approval. */
  notice?: string | null;
  onAdd: (target: ShareTarget) => void;
  onRemove: (grantId: string) => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<"principal" | "workspace" | "space">("principal");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<PrincipalCandidate[]>([]);
  const [picked, setPicked] = useState<PrincipalCandidate | null>(null);
  const [level, setLevel] = useState<AccessLevel>("run");

  useEffect(() => {
    if (kind !== "principal" || query.trim().length < 2 || picked?.label === query) {
      setFound([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      search(query.trim()).then(
        (next) => live && setFound(next),
        () => live && setFound([]),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [kind, query, picked, search]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (kind === "space") return;
    if (kind === "workspace") return onAdd({ principalType: "workspace", level });
    if (!picked) return;
    onAdd({ principalType: picked.principalType, principalId: picked.principalId, level });
    setPicked(null);
    setQuery("");
  };

  const waiting = requests.filter((r) => r.status !== "accepted");
  const asks = policy
    ? [
        policy.individual && "people",
        policy.group && "groups",
        policy.workspace && "the whole workspace",
      ].filter(Boolean)
    : [];

  return (
    <div className="grid gap-4">
      {policy && (
        <p className="text-dense text-fg-muted">
          {asks.length === 0
            ? "Shares take effect at once."
            : `Sharing with ${asks.join(", ")} waits for an admin to approve.`}
        </p>
      )}
      <section aria-labelledby={`${id}-current`} className="grid gap-2">
        <h3 id={`${id}-current`} className="text-ui font-semibold">
          Shared with
        </h3>
        {grants.length === 0 && waiting.length === 0 ? (
          <p className="text-dense text-fg-muted">Only you.</p>
        ) : (
          <ul className="grid gap-1">
            {grants.map((g) => {
              const Icon = ICON[g.principalType];
              return (
                <li
                  key={g.id}
                  className="flex items-center gap-2 rounded-md border border-border px-2 py-1"
                >
                  <Icon aria-hidden className="size-4 text-fg-muted" strokeWidth={1.5} />
                  <span className="min-w-0 flex-1 truncate text-dense">{g.label}</span>
                  <span className="text-caption text-fg-muted">{ACCESS_LABEL[g.level]}</span>
                  <Button
                    size="icon"
                    variant="quiet"
                    aria-label={`Stop sharing with ${g.label}`}
                    disabled={busy}
                    onClick={() => onRemove(g.id)}
                  >
                    <X aria-hidden />
                  </Button>
                </li>
              );
            })}
            {waiting.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border px-2 py-1"
              >
                <Clock aria-hidden className="size-4 text-fg-muted" strokeWidth={1.5} />
                <span className="min-w-0 flex-1 truncate text-dense">{r.label}</span>
                <span className="text-caption text-fg-muted">{ACCESS_LABEL[r.level]}</span>
                {r.status === "pending" ? (
                  <StatusText tone="warning" className="text-caption">
                    Pending approval
                  </StatusText>
                ) : (
                  <StatusText tone="failed" className="text-caption">
                    Denied{r.reason ? `: ${r.reason}` : ""}
                  </StatusText>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <form onSubmit={submit} aria-label="Share" className="grid gap-3">
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-ui font-semibold">Add</legend>
          {(
            [
              ["principal", "A person or group"],
              ["workspace", "Everyone in the workspace"],
              ["space", "A Space"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-ui">
              <input
                type="radio"
                name={`${id}-kind`}
                checked={kind === value}
                onChange={() => setKind(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        {kind === "principal" && (
          <div className="grid gap-1">
            <Label htmlFor={`${id}-who`}>Name, email or group</Label>
            <Input
              id={`${id}-who`}
              role="combobox"
              aria-expanded={found.length > 0}
              aria-controls={found.length > 0 ? `${id}-found` : undefined}
              aria-autocomplete="list"
              autoComplete="off"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPicked(null);
              }}
            />
            {found.length > 0 && (
              <ul id={`${id}-found`} aria-label="Matches" className="grid gap-0.5">
                {found.map((c) => {
                  const Icon = ICON[c.principalType];
                  return (
                    <li key={`${c.principalType}:${c.principalId}`}>
                      <button
                        type="button"
                        onClick={() => {
                          setPicked(c);
                          setQuery(c.label);
                          setFound([]);
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-dense hover:tint-hover"
                      >
                        <Icon aria-hidden className="size-4 text-fg-muted" strokeWidth={1.5} />
                        {c.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {kind === "space" && (
          <p className="text-dense text-fg-muted">
            Sharing into a Space becomes available once Spaces are turned on for this workspace.
          </p>
        )}
        <div className="grid gap-1">
          <Label htmlFor={`${id}-level`}>Access</Label>
          <select
            id={`${id}-level`}
            className={selectStyles}
            value={level}
            onChange={(e) => setLevel(e.target.value as AccessLevel)}
          >
            {LEVEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {notice && (
          <p role="status" className="text-dense text-fg">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="text-dense text-destructive">
            {error}
          </p>
        )}
        <div>
          <Button
            type="submit"
            disabled={busy || kind === "space" || (kind === "principal" && !picked)}
          >
            Share
          </Button>
        </div>
      </form>
    </div>
  );
}

export function AgentShareFormSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-2">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}
