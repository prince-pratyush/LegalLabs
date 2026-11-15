import { Breadcrumbs, Button, DataTable, type TableColumn } from "@legallabs/ui";
import { useCallback, useEffect, useState } from "react";
import { type BinItem, vaultApi } from "./api.js";
import { go } from "./route.js";
import { formatDate, messageOf } from "./shared.js";

export function RecycleBin({ vaultId }: { vaultId: string }) {
  const [items, setItems] = useState<BinItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    vaultApi.bin(vaultId).then(setItems, (err) => setError(messageOf(err)));
  }, [vaultId]);
  useEffect(load, [load]);

  const restore = async (item: BinItem) => {
    try {
      await vaultApi.restore(
        vaultId,
        item.kind === "document" ? [item.id] : [],
        item.kind === "folder" ? [item.id] : [],
      );
      load();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const daysLeft = (iso: string) =>
    Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
  const columns: TableColumn<BinItem>[] = [
    { id: "name", header: "Name", cell: (i) => (i.kind === "folder" ? `${i.name}/` : i.name) },
    {
      id: "why",
      header: "Removed by",
      width: 160,
      cell: (i) => (i.deleted_reason === "retention" ? "Retention policy" : "A person"),
    },
    { id: "when", header: "Deleted", width: 130, cell: (i) => formatDate(i.deleted_at) },
    {
      id: "left",
      header: "Days left",
      width: 100,
      align: "end",
      cell: (i) => daysLeft(i.purge_at),
    },
    {
      id: "restore",
      header: "Restore",
      width: 110,
      cell: (i) => (
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Restore ${i.name}`}
          onClick={() => restore(i)}
        >
          Restore
        </Button>
      ),
    },
  ];

  return (
    <div className="grid max-w-5xl gap-4">
      <Breadcrumbs
        items={[
          { id: vaultId, label: "Vault" },
          { id: null, label: "Recycle bin" },
        ]}
        onSelect={() => go({ page: "vault", vaultId, folderId: null })}
      />
      <h1 className="text-title font-semibold">Recycle bin</h1>
      <p className="text-ui text-fg-muted">
        Items stay here for 30 days, then are deleted for good.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <DataTable
        label="Deleted items"
        columns={columns}
        rows={items ?? []}
        loading={items === null}
        getRowId={(i) => i.id}
        empty="The bin is empty."
      />
    </div>
  );
}
