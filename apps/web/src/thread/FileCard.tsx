import { Button } from "@legallabs/ui";
import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { useState } from "react";
import { api, messageOf, type ThreadOutput } from "../api.js";
import { download } from "../download.js";

const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** A file the thread made, fetched so a refusal is shown here rather than saved as the file. */
export function FileCard({ output }: { output: ThreadOutput }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Icon = output.format === "xlsx" ? FileSpreadsheet : FileText;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      download(await api.outputFile(output.id), output.name);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-3 rounded-md border border-border bg-bg-subtle p-3">
        <Icon aria-hidden className="size-5 text-fg-muted" strokeWidth={1.5} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-semibold">{output.name}</span>
          <span className="text-caption text-fg-muted">{size(output.size)}</span>
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          aria-label={`Download ${output.name}`}
          onClick={() => void save()}
        >
          <Download aria-hidden />
          Download
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-dense text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
