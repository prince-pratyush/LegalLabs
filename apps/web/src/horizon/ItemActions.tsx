import { hasAccess } from "@legallabs/contracts";
import { Button, Field, NativeSelect } from "@legallabs/ui";
import { useEffect, useState } from "react";
import { api, messageOf } from "../api.js";
import { navigate, paths } from "../router.js";
import { vaultApi } from "../vaults/api.js";
import { horizonApi } from "./api.js";

const POLL_MS = 1500;
const POLLS = 40;

/** Waits until a stored file can be read, so a question asked of it finds its words. */
async function read(documentId: string, wait: number) {
  for (let n = 0; n < POLLS; n++) {
    const { status } = await api.document(documentId);
    if (status !== "queued" && status !== "parsing") return;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** What to do with one item: keep a copy, ask about it, or start an email. */
export function ItemActions({ itemId, pollMs = POLL_MS }: { itemId: string; pollMs?: number }) {
  const [vaults, setVaults] = useState<{ id: string; name: string }[]>([]);
  const [vaultId, setVaultId] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    vaultApi.list().then(
      (all) => setVaults(all.filter((v) => hasAccess(v.my_access, "edit"))),
      () => undefined,
    );
  }, []);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      await horizonApi.saveToVault(itemId, vaultId);
      setNote("Saved to the vault.");
    });

  const ask = () =>
    run(async () => {
      const made = await horizonApi.ask(itemId);
      setNote("Reading the file…");
      await read(made.document_id, pollMs);
      navigate(paths.thread(made.thread_id));
    });

  const draft = () =>
    run(async () => {
      const made = await horizonApi.draftEmail(itemId);
      navigate(`${paths.thread(made.thread_id)}?drafts=${encodeURIComponent(made.draft_id)}`);
    });

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Button size="sm" disabled={busy} onClick={() => void ask()}>
          Ask about this
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void draft()}>
          Draft email
        </Button>
        <Field label="Vault">
          {(props) => (
            <NativeSelect {...props} value={vaultId} onChange={(e) => setVaultId(e.target.value)}>
              <option value="">Choose a vault</option>
              {vaults.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !vaultId}
          onClick={() => void save()}
        >
          Save to vault
        </Button>
      </div>
      {note && <p role="status">{note}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
