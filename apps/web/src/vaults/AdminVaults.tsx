import { Button, ConfirmDialog, DataTable, type TableColumn } from "@legallabs/ui";
import { useCallback, useEffect, useState } from "react";
import { type AdminVault, vaultApi } from "./api.js";
import { formatBytes, messageOf } from "./shared.js";

export function AdminVaults({ onChanged }: { onChanged: () => void }) {
  const [vaults, setVaults] = useState<AdminVault[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    vaultApi.adminList().then(setVaults, (err) => setError(messageOf(err)));
  }, []);
  useEffect(load, [load]);

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      load();
      onChanged();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const columns: TableColumn<AdminVault>[] = [
    { id: "name", header: "Name", cell: (v) => v.name, sortValue: (v) => v.name.toLowerCase() },
    {
      id: "owner",
      header: "Owner",
      width: 220,
      cell: (v) => v.owner_email,
      sortValue: (v) => v.owner_email,
    },
    {
      id: "files",
      header: "Files",
      width: 90,
      align: "end",
      cell: (v) => v.files.toLocaleString(),
      sortValue: (v) => v.files,
    },
    {
      id: "size",
      header: "Size",
      width: 100,
      align: "end",
      cell: (v) => formatBytes(v.bytes),
      sortValue: (v) => v.bytes,
    },
    { id: "shared", header: "Shared with", width: 110, align: "end", cell: (v) => v.grants },
    {
      id: "retention",
      header: "Retention",
      width: 110,
      cell: (v) => (v.retention_hours ? `${v.retention_hours} h` : "None"),
    },
    {
      id: "state",
      header: "State",
      width: 260,
      cell: (v) =>
        v.deleted_at ? (
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => act(() => vaultApi.restoreVault(v.id))}
            >
              Restore
            </Button>
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="destructive">
                  Purge now
                </Button>
              }
              title={`Purge ${v.name}?`}
              description={`Its ${v.files.toLocaleString()} files are deleted for good. This can't be undone.`}
              confirmLabel="Purge vault"
              destructive
              onConfirm={() => act(() => vaultApi.purge(v.id))}
            />
          </span>
        ) : (
          "Active"
        ),
    },
  ];

  return (
    <div className="grid gap-4">
      <h1 className="text-title font-semibold">Every vault</h1>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <DataTable
        label="Every vault in the workspace"
        columns={columns}
        rows={vaults ?? []}
        loading={vaults === null}
        getRowId={(v) => v.id}
        empty="No vaults yet."
      />
    </div>
  );
}
