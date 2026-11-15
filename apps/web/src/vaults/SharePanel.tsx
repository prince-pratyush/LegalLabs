import type { VaultGrant, VaultLevel } from "@legallabs/contracts";
import {
  Button,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SidePanel,
  Skeleton,
  StatusText,
} from "@legallabs/ui";
import { useEffect, useState } from "react";
import { type Shares, type Vault, vaultApi } from "./api.js";
import { CheckRow, messageOf } from "./shared.js";

const LEVELS: { value: VaultLevel; label: string }[] = [
  { value: "view", label: "Can view" },
  { value: "edit", label: "Can edit" },
  { value: "full", label: "Full access" },
];

export function SharePanel({ vault, onClose }: { vault: Vault; onClose: () => void }) {
  const [shares, setShares] = useState<Shares | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<
    { principal_type: "user" | "group"; principal_id: string; label: string }[]
  >([]);
  const [denied, setDenied] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(420);

  useEffect(() => {
    vaultApi.shares(vault.id).then(setShares, (err) => setError(messageOf(err)));
  }, [vault.id]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setFound([]);
      return;
    }
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/v1/vaults/principals?q=${encodeURIComponent(query.trim())}`, {
        credentials: "same-origin",
      });
      if (res.ok) setFound(((await res.json()) as { principals: typeof found }).principals);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const save = async (grants: (VaultGrant & { name: string })[], workspaceView: boolean) => {
    setError(null);
    try {
      const next = await vaultApi.setShares(
        vault.id,
        grants.map(({ principal_type, principal_id, level }) => ({
          principal_type,
          principal_id,
          level,
        })),
        workspaceView,
      );
      setShares(next);
      const names = new Map([...grants].map((g) => [g.principal_id, g.name]));
      setDenied((next.denied_by_wall ?? []).map((id) => names.get(id) ?? "A group member"));
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <SidePanel
      title={`Share ${vault.name}`}
      onClose={onClose}
      width={width}
      onWidthChange={setWidth}
    >
      <div className="grid gap-4 overflow-auto p-4">
        {shares === null ? (
          <div aria-busy="true" className="grid gap-2">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : (
          <>
            <Field label="Add people or groups" hint="Search by email or group name.">
              {(props) => (
                <Input {...props} value={query} onChange={(e) => setQuery(e.target.value)} />
              )}
            </Field>
            {found.length > 0 && (
              <ul aria-label="Matches" className="grid gap-1">
                {found
                  .filter((f) => !shares.grants.some((g) => g.principal_id === f.principal_id))
                  .map((f) => (
                    <li key={f.principal_id} className="flex items-center gap-2">
                      <span className="flex-1 truncate text-ui">
                        {f.label}{" "}
                        {f.principal_type === "group" && (
                          <span className="text-fg-muted">(group)</span>
                        )}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setQuery("");
                          void save(
                            [
                              ...shares.grants,
                              {
                                principal_type: f.principal_type,
                                principal_id: f.principal_id,
                                level: "view",
                                name: f.label,
                              },
                            ],
                            shares.workspace_view,
                          );
                        }}
                      >
                        Add
                      </Button>
                    </li>
                  ))}
              </ul>
            )}
            {denied.length > 0 && (
              <StatusText tone="locked">
                {denied.join(", ")} {denied.length === 1 ? "is" : "are"} walled off from this
                vault's matter and won't see it.
              </StatusText>
            )}
            <ul aria-label="People with access" className="grid gap-2">
              {shares.grants.map((g) => (
                <li key={g.principal_id} className="flex items-center gap-2">
                  <span className="flex-1 truncate text-ui">{g.name}</span>
                  <Select
                    value={g.level}
                    onValueChange={(level) =>
                      save(
                        shares.grants.map((x) =>
                          x.principal_id === g.principal_id
                            ? { ...x, level: level as VaultLevel }
                            : x,
                        ),
                        shares.workspace_view,
                      )
                    }
                  >
                    <SelectTrigger aria-label={`Access for ${g.name}`} className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LEVELS.map((l) => (
                        <SelectItem key={l.value} value={l.value}>
                          {l.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() =>
                      save(
                        shares.grants.filter((x) => x.principal_id !== g.principal_id),
                        shares.workspace_view,
                      )
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <CheckRow
              checked={shares.workspace_view}
              onChange={(checked) => save(shares.grants, checked)}
              label="Everyone in the workspace can view"
            />
            <ContentControlsForm vault={vault} />
          </>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
    </SidePanel>
  );
}

const CONTROLS = [
  {
    key: "allow_download",
    label: "Allow download",
    detail: "People who can view may download originals.",
  },
  {
    key: "allow_duplicate",
    label: "Allow duplication",
    detail: "People who can view may copy files or extracted text elsewhere.",
  },
  {
    key: "show_review_prompts",
    label: "Show recent questions",
    detail: "People who can view see the vault's recent questions.",
  },
] as const;

function ContentControlsForm({ vault }: { vault: Vault }) {
  const [controls, setControls] = useState(vault.content_controls);
  const [error, setError] = useState<string | null>(null);
  return (
    <fieldset className="grid gap-2 border-t border-border pt-4">
      <legend className="text-ui font-medium">For people who can view</legend>
      {CONTROLS.map((c) => (
        <CheckRow
          key={c.key}
          checked={controls[c.key]}
          label={c.label}
          detail={c.detail}
          onChange={async (checked) => {
            const next = { ...controls, [c.key]: checked };
            setControls(next);
            try {
              await vaultApi.update(vault.id, { content_controls: next });
            } catch (err) {
              setControls(controls);
              setError(messageOf(err));
            }
          }}
        />
      ))}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
