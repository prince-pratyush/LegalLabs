import { type Api, messageOf } from "@legallabs/addin";
import type { OutlookSaved } from "@legallabs/contracts";
import { Button, Field, NativeSelect, StatusText } from "@legallabs/ui";
import { useState } from "react";
import { collect } from "../mail/collect.js";
import type { MailHost, MailItem } from "../office/host.js";

type Vault = { id: string; name: string; my_access: string | null };
type Saved = Pick<OutlookSaved, "folder_name" | "files" | "skipped">;

const WRITABLE = ["edit", "full", "owner"];

/** Files the open message and its attachments in a folder of a vault the person picks. */
export function SavePanel({ api, host, item }: { api: Api; host: MailHost; item: MailItem }) {
  const [vaults, setVaults] = useState<Vault[] | null>(null);
  const [vaultId, setVaultId] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<(Saved & { vault: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const choose = () =>
    run(async () => {
      const { vaults: all } = await api.get<{ vaults: Vault[] }>("/api/v1/vaults");
      setVaults(all.filter((v) => WRITABLE.includes(v.my_access ?? "")));
    });

  const save = () =>
    run(async () => {
      setSaved(null);
      const { form, skipped } = await collect(host, item);
      form.append("vault_id", vaultId);
      const made = await api.upload<Saved>("/api/v1/addins/outlook/save-to-vault", form);
      const vault = vaults?.find((v) => v.id === vaultId)?.name ?? "the vault";
      setSaved({ ...made, skipped: [...skipped, ...made.skipped], vault });
    });

  return (
    <section aria-label="Save to vault" className="grid gap-2 border-t border-border pt-3">
      {!vaults ? (
        <Button
          variant="secondary"
          className="justify-self-start"
          disabled={busy}
          onClick={() => void choose()}
        >
          Save to vault
        </Button>
      ) : vaults.length === 0 ? (
        <p className="text-dense text-fg-muted">There's no vault you can add files to.</p>
      ) : (
        <>
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
            className="justify-self-start"
            disabled={busy || !vaultId}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save email"}
          </Button>
        </>
      )}
      {saved && (
        <div className="grid gap-1 text-dense">
          <p>
            Saved {saved.files.length} {saved.files.length === 1 ? "file" : "files"} to{" "}
            {saved.vault} / {saved.folder_name}
          </p>
          {saved.skipped.map((s) => (
            <p key={`${s.name}-${s.reason}`} className="text-fg-muted">
              Not saved: {s.name}
            </p>
          ))}
        </div>
      )}
      {error && <StatusText tone="failed">{error}</StatusText>}
    </section>
  );
}
