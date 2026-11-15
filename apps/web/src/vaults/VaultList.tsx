import {
  Button,
  DataTable,
  EmptyState,
  Field,
  Input,
  type TableColumn,
  Textarea,
} from "@legallabs/ui";
import { Vault as VaultIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { type Vault, vaultApi } from "./api.js";
import { go } from "./route.js";
import { ACCESS_LABEL, formatDate, messageOf } from "./shared.js";

export function VaultList({
  vaults,
  onChanged,
}: {
  vaults: (Vault & { files: number })[] | null;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const vault = await vaultApi.create(name.trim(), description.trim());
      onChanged();
      go({ page: "vault", vaultId: vault.id, folderId: null });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumn<Vault & { files: number }>[] = [
    { id: "name", header: "Name", cell: (v) => v.name, sortValue: (v) => v.name.toLowerCase() },
    {
      id: "files",
      header: "Files",
      cell: (v) => v.files.toLocaleString(),
      sortValue: (v) => v.files,
      align: "end",
      width: 100,
    },
    {
      id: "access",
      header: "Access",
      cell: (v) => (v.my_access ? ACCESS_LABEL[v.my_access] : "—"),
      width: 140,
    },
    {
      id: "updated",
      header: "Updated",
      cell: (v) => formatDate(v.updated_at),
      sortValue: (v) => v.updated_at,
      width: 140,
    },
  ];

  return (
    <div className="grid max-w-5xl gap-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-title font-semibold">Vaults</h1>
        <Button onClick={() => setCreating(!creating)}>Create vault</Button>
      </header>
      {creating && (
        <form onSubmit={create} className="grid max-w-lg gap-3 rounded-md border border-border p-4">
          <Field label="Name">
            {(props) => (
              <Input
                {...props}
                value={name}
                maxLength={200}
                required
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label="Description" hint="Optional. Who it's for and what goes in it.">
            {(props) => (
              <Textarea
                {...props}
                value={description}
                maxLength={2000}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || name.trim() === ""}>
              {busy ? "Creating…" : "Create"}
            </Button>
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {vaults !== null && vaults.length === 0 && !creating ? (
        <EmptyState
          icon={VaultIcon}
          title="No vaults yet"
          description="A vault holds the files for one deal, case or project, shared with the people working on it."
          action={{ label: "Create vault", onClick: () => setCreating(true) }}
        />
      ) : (
        <DataTable
          label="Vaults"
          columns={columns}
          rows={vaults ?? []}
          loading={vaults === null}
          getRowId={(v) => v.id}
          onActivate={(v) => go({ page: "vault", vaultId: v.id, folderId: null })}
          empty="No vaults"
        />
      )}
    </div>
  );
}
