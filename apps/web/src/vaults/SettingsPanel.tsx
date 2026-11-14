import { Button, ConfirmDialog, Field, Input, SidePanel, Textarea } from "@legallabs/ui";
import { type FormEvent, useEffect, useState } from "react";
import { type Vault, vaultApi } from "./api.js";
import { CheckRow, messageOf } from "./shared.js";

export function SettingsPanel({
  vault,
  onSaved,
  onDeleted,
  onClose,
}: {
  vault: Vault;
  onSaved: (vault: Vault) => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(vault.name);
  const [description, setDescription] = useState(vault.description);
  const [keep, setKeep] = useState(vault.retention_hours !== null);
  const [hours, setHours] = useState(String(vault.retention_hours ?? 720));
  const [estimate, setEstimate] = useState<{ documents: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(420);
  const parsedHours = Number(hours);
  const validHours = Number.isInteger(parsedHours) && parsedHours >= 3;

  useEffect(() => {
    if (!keep || !validHours) {
      setEstimate(null);
      return;
    }
    const timer = setTimeout(() => {
      vaultApi.retentionEstimate(vault.id, parsedHours).then(setEstimate, () => setEstimate(null));
    }, 300);
    return () => clearTimeout(timer);
  }, [keep, validHours, parsedHours, vault.id]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await vaultApi.update(vault.id, {
          name: name.trim(),
          description: description.trim(),
          retention_hours: keep ? parsedHours : null,
        }),
      );
      onClose();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidePanel title="Vault settings" onClose={onClose} width={width} onWidthChange={setWidth}>
      <form onSubmit={save} className="grid gap-4 overflow-auto p-4">
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
        <Field label="Description">
          {(props) => (
            <Textarea
              {...props}
              value={description}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
        <fieldset className="grid gap-2">
          <legend className="text-ui font-medium">Retention</legend>
          <CheckRow
            checked={keep}
            onChange={setKeep}
            label="Move files to the recycle bin after a set time"
          />
          {keep && (
            <Field
              label="Hours to keep each file"
              hint={
                estimate
                  ? `${estimate.documents.toLocaleString()} ${estimate.documents === 1 ? "file is" : "files are"} older than this and would go to the bin within a day.`
                  : "At least 3. 720 hours is 30 days."
              }
              {...(validHours ? {} : { error: "Enter a whole number of hours, at least 3." })}
            >
              {(props) => (
                <Input
                  {...props}
                  inputMode="numeric"
                  value={hours}
                  className="w-32"
                  onChange={(e) => setHours(e.target.value)}
                />
              )}
            </Field>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || name.trim() === "" || (keep && !validHours)}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <ConfirmDialog
            trigger={<Button variant="destructive">Delete vault</Button>}
            title={`Delete ${vault.name}?`}
            description="It moves to the recycle bin with every file in it. You or an admin can restore it within 30 days."
            confirmLabel="Delete vault"
            destructive
            onConfirm={async () => {
              try {
                await vaultApi.remove(vault.id);
                onDeleted();
              } catch (err) {
                setError(messageOf(err));
              }
            }}
          />
        </div>
      </form>
    </SidePanel>
  );
}
