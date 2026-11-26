import { Button, Checkbox } from "@legallabs/ui";
import { useState } from "react";
import { messageOf, Panel, useLoad, when } from "../admin/load.js";
import { Card, Nothing, Table } from "../command-center/parts.js";
import { type BinItem, retentionApi } from "./api.js";
import { TYPE_LABEL } from "./HoldsTab.js";

const stateOf = (item: BinItem, now = Date.now()) => {
  if (item.restoredAt) return `Restored ${when(item.restoredAt)}`;
  if (item.purgedAt) return `Deleted for good ${when(item.purgedAt)}`;
  if (Date.parse(item.restorableUntil) <= now) return "Too late to restore";
  return null;
};

export function BinTab() {
  const [closed, setClosed] = useState(false);
  const items = useLoad(() => retentionApi.bin(closed), [closed]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const restore = (item: BinItem) => {
    setMessage(null);
    retentionApi.restore(item.id).then(
      () => {
        setMessage({ ok: true, text: `Restored ${item.label}. Its retention clock restarts now.` });
        items.reload();
      },
      (e: unknown) => setMessage({ ok: false, text: messageOf(e) }),
    );
  };
  return (
    <Card title="Recycle bin">
      <p className="text-dense text-fg-muted">
        What retention removed, restorable for 30 days. Files people delete themselves are in each
        vault's own bin.
      </p>
      <label htmlFor="bin-closed" className="flex items-center gap-2 text-ui">
        <Checkbox id="bin-closed" checked={closed} onCheckedChange={(v) => setClosed(v === true)} />
        Show restored and permanently deleted items
      </label>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "" : "text-destructive"}>
          {message.text}
        </p>
      )}
      <Panel state={items}>
        {(rows) =>
          rows.length === 0 ? (
            <Nothing>Retention has not removed anything that is still here.</Nothing>
          ) : (
            <Table
              label="Recycle bin"
              head={["Item", "Type", "Removed", "Restorable until", ""]}
              rows={rows.map((item) => ({
                key: item.id,
                cells: [
                  item.label,
                  TYPE_LABEL[item.objectType],
                  when(item.deletedAt),
                  when(item.restorableUntil),
                  stateOf(item) ?? (
                    <Button
                      key="restore"
                      variant="secondary"
                      size="sm"
                      aria-label={`Restore ${item.label}`}
                      onClick={() => restore(item)}
                    >
                      Restore
                    </Button>
                  ),
                ],
              }))}
            />
          )
        }
      </Panel>
    </Card>
  );
}
