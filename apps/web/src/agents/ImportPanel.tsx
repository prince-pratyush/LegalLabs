import { ImportPreview, Label } from "@legallabs/ui";
import { useId, useState } from "react";
import { type Agent, agentApi, agentError, type ImportPreviewResponse } from "./api.js";

/** Pick a file, see what it holds, then confirm; nothing is stored before Confirm. */
export function ImportPanel({
  onCancel,
  onImported,
}: {
  onCancel: () => void;
  onImported: (agent: Agent) => void;
}) {
  const id = useId();
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await agentApi.importFile(file));
    } catch (err) {
      setError(agentError(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (choice: { title: string; dropLabels: string[] }) => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      onImported(
        await agentApi.confirmImport(preview.token, {
          title: choice.title,
          drop_labels: choice.dropLabels,
        }),
      );
    } catch (err) {
      setError(agentError(err));
    } finally {
      setBusy(false);
    }
  };

  if (preview) {
    return (
      <ImportPreview
        preview={preview}
        busy={busy}
        error={error}
        onConfirm={confirm}
        onCancel={() => {
          setPreview(null);
          setError(null);
        }}
      />
    );
  }
  return (
    <div className="grid gap-3">
      <p className="text-dense text-fg-muted">
        A .md file (up to 1 MB), or a .skill or .zip bundle with a SKILL.md (up to 50 MB and 50
        files).
      </p>
      <div className="grid gap-1">
        <Label htmlFor={id}>File to import</Label>
        <input
          id={id}
          type="file"
          accept=".md,.skill,.zip,text/markdown,application/zip"
          disabled={busy}
          className="text-ui"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void read(file);
          }}
        />
      </div>
      {busy && <p className="text-dense text-fg-muted">Reading the file…</p>}
      {error && (
        <p role="alert" className="text-dense text-destructive">
          {error}
        </p>
      )}
      <div>
        <button type="button" className="text-dense text-accent underline" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
