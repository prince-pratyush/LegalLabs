import { type FormEvent, useState } from "react";
import { cn } from "../../cn.js";
import { Button } from "../button.js";
import { Checkbox } from "../checkbox.js";
import { SidePanel } from "../side-panel.js";

export type SyncMode = "off" | "entire_vault" | "selected_folders";

/** What the person chooses; the server's status adds the state around it. */
export interface SyncSettings {
  mode: SyncMode;
  folder_ids: string[] | null;
  notify: boolean;
}

export interface SyncInfo extends SyncSettings {
  state: "off" | "idle" | "pending";
  pending_rows: number;
  removed_rows: number;
  last_synced_at: string | null;
}

const MODES: { id: SyncMode; name: string; hint: string }[] = [
  { id: "off", name: "Off", hint: "Rows are added by hand." },
  {
    id: "entire_vault",
    name: "Entire vault",
    hint: "Every new file in the vault becomes a row.",
  },
  {
    id: "selected_folders",
    name: "Selected folders",
    hint: "New files in the folders you choose, and the folders inside them.",
  },
];

/** "Sync pending (3)" while new rows are working, "Files synced" when idle; nothing when off. */
export function SyncIndicator({ sync, onClick }: { sync: SyncInfo | null; onClick: () => void }) {
  if (!sync || sync.state === "off") return null;
  const pending = sync.state === "pending";
  return (
    <Button
      variant="quiet"
      size="sm"
      onClick={onClick}
      aria-label={`Sync settings: ${pending ? `${sync.pending_rows} pending` : "files synced"}`}
    >
      <span
        aria-hidden
        className={cn("size-2 rounded-full", pending ? "bg-flag-orange" : "bg-flag-green")}
      />
      {pending ? `Sync pending (${sync.pending_rows})` : "Files synced"}
    </Button>
  );
}

/** Keep a table over a vault in step with it: new files become rows, and columns run on them. */
export function SyncPanel({
  sync,
  folders,
  onSave,
  onSyncNow,
  onClose,
  width = 400,
}: {
  sync: SyncInfo;
  /** Folders of the table's vault the person can choose from. */
  folders: { id: string; name: string }[];
  onSave: (settings: SyncSettings) => Promise<void>;
  onSyncNow: () => Promise<void>;
  onClose: () => void;
  width?: number;
}) {
  const [mode, setMode] = useState<SyncMode>(sync.mode);
  const [chosen, setChosen] = useState<Set<string>>(new Set(sync.folder_ids ?? []));
  const [notify, setNotify] = useState(sync.notify);
  const [busy, setBusy] = useState<"save" | "now" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const problem =
    mode === "selected_folders" && chosen.size === 0 ? "Choose at least one folder." : null;

  const run = async (kind: "save" | "now", action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (problem) return;
    void run("save", () =>
      onSave({
        mode,
        folder_ids: mode === "selected_folders" ? [...chosen] : null,
        notify: mode === "off" ? false : notify,
      }),
    );
  };

  const toggle = (id: string, on: boolean) =>
    setChosen((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <SidePanel title="Vault sync" onClose={onClose} width={width}>
      <form onSubmit={save} className="grid gap-4">
        <fieldset className="grid gap-2">
          <legend className="sr-only">What to sync</legend>
          {MODES.map((m) => (
            <label
              key={m.id}
              className="flex cursor-pointer gap-2 rounded-md border border-border p-3 has-checked:border-accent has-checked:tint-selected"
            >
              <input
                type="radio"
                name="sync-mode"
                checked={mode === m.id}
                onChange={() => setMode(m.id)}
                className="mt-1"
              />
              <span className="grid">
                <span className="font-medium">{m.name}</span>
                <span className="text-caption text-fg-muted">{m.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {mode === "selected_folders" && (
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-ui font-medium">Folders</legend>
            {folders.length === 0 && (
              <p className="text-caption text-fg-muted">This vault has no folders yet.</p>
            )}
            {folders.map((f) => (
              <span key={f.id} className="flex items-center gap-2 text-ui">
                <Checkbox
                  id={`sync-folder-${f.id}`}
                  checked={chosen.has(f.id)}
                  onCheckedChange={(value) => toggle(f.id, value === true)}
                />
                <label htmlFor={`sync-folder-${f.id}`}>{f.name}</label>
              </span>
            ))}
          </fieldset>
        )}
        {mode !== "off" && (
          <span className="flex items-center gap-2 text-ui">
            <Checkbox
              id="sync-notify"
              checked={notify}
              onCheckedChange={(value) => setNotify(value === true)}
            />
            <label htmlFor="sync-notify">Tell me when sync adds rows</label>
          </span>
        )}
        <p className="text-caption text-fg-muted">
          New files are read as you, so your matter walls apply. Only columns that have run before
          run on new rows; start new columns yourself. A newer version of a file gets a row of its
          own. Files that leave the vault keep their rows but can't be re-run.
        </p>
        {(problem || error) && (
          <p role="alert" className="text-caption text-destructive">
            {error ?? problem}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy !== null || problem !== null}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
          {sync.mode !== "off" && (
            <Button
              variant="secondary"
              disabled={busy !== null}
              onClick={() => void run("now", onSyncNow)}
            >
              {busy === "now" ? "Syncing…" : "Sync now"}
            </Button>
          )}
        </div>
        {sync.mode !== "off" && (
          <p className="text-caption text-fg-muted">
            {sync.last_synced_at
              ? `Last synced ${new Date(sync.last_synced_at).toLocaleString()}.`
              : "Not synced yet."}
            {sync.removed_rows > 0
              ? ` ${sync.removed_rows} ${sync.removed_rows === 1 ? "file has" : "files have"} left the vault.`
              : ""}
          </p>
        )}
      </form>
    </SidePanel>
  );
}
