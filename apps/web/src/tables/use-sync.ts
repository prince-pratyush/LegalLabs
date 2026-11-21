import type { ReviewTable, SyncStatus } from "@legallabs/contracts";
import type { SyncSettings } from "@legallabs/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { vaultApi } from "../vaults/api.js";
import { tableApi } from "./api.js";

const POLL_MS = 5000;

/**
 * A vault table's sync status, kept current while sync is on (so new rows show up), and the
 * actions behind the sync panel. A table over uploads has none.
 */
export function useSync(table: ReviewTable | null, onChange: () => void) {
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const tableId = table?.id;
  const vaultId = table?.vault_id ?? null;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const seen = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!tableId || !vaultId) return;
    const next = await tableApi.sync(tableId);
    setSync(next);
    // A new pass, or rows finishing, means the grid has something new to show.
    const stamp = `${next.last_synced_at}|${next.pending_rows}`;
    if (seen.current !== null && seen.current !== stamp) onChangeRef.current();
    seen.current = stamp;
  }, [tableId, vaultId]);

  useEffect(() => {
    load().catch(() => setSync(null));
  }, [load]);

  const on = sync !== null && sync.mode !== "off";
  useEffect(() => {
    if (!on) return;
    const poll = setInterval(() => void load().catch(() => {}), POLL_MS);
    return () => clearInterval(poll);
  }, [on, load]);

  const loadFolders = useCallback(async () => {
    if (!vaultId) return;
    setFolders((await vaultApi.tree(vaultId, {})).folders.map((f) => ({ id: f.id, name: f.name })));
  }, [vaultId]);

  const save = useCallback(
    async (settings: SyncSettings) => {
      if (!tableId) return;
      setSync(
        await tableApi.putSync(tableId, {
          mode: settings.mode,
          notify: settings.notify,
          ...(settings.folder_ids ? { folder_ids: settings.folder_ids } : {}),
        }),
      );
    },
    [tableId],
  );

  const syncNow = useCallback(async () => {
    if (!tableId) return;
    await tableApi.syncNow(tableId);
    await load();
    onChangeRef.current();
  }, [tableId, load]);

  return { sync: vaultId ? sync : null, folders, loadFolders, save, syncNow };
}
