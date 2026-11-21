import { Button, Checkbox, Field, Input, toast } from "@legallabs/ui";
import { useState } from "react";
import { messageOf } from "../api.js";
import { type ImportPreview, memoryApi } from "./api.js";

export const EXPORT_PROMPT =
  "List every memory you hold about me as CSV with the columns text,category,created_at,source_platform. Put one memory per row, quote any text that contains commas, and include nothing else.";

const PROVIDERS = ["ChatGPT", "Claude", "Gemini", "Copilot", "Perplexity", "Other"];

interface Review {
  line: number;
  text: string;
  edited: boolean;
  keep: boolean;
  status: "ok" | "duplicate" | "error";
  error?: string | undefined;
}

export function ImportMemories({ onImported }: { onImported: () => void }) {
  const [provider, setProvider] = useState(PROVIDERS[0]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [rows, setRows] = useState<Review[]>([]);
  const [busy, setBusy] = useState(false);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const parsed = await memoryApi.parseImport(file);
      setPreview(parsed);
      setRows(
        parsed.rows.map((r) => ({
          line: r.line,
          text: r.text,
          edited: false,
          keep: r.status === "ok",
          status: r.status,
          error: r.error,
        })),
      );
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const chosen = rows
        .filter((r) => r.keep && r.status === "ok")
        .map((r) => (r.edited ? { line: r.line, text: r.text } : { line: r.line }));
      const out = await memoryApi.commitImport(preview.import_id, chosen);
      toast.success(
        `Imported ${out.created} ${out.created === 1 ? "memory" : "memories"}${out.skipped ? `; ${out.skipped} skipped` : ""}.`,
      );
      setPreview(null);
      setRows([]);
      onImported();
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const keeping = rows.filter((r) => r.keep && r.status === "ok").length;
  const set = (line: number, change: Partial<Review>) =>
    setRows((all) => all.map((r) => (r.line === line ? { ...r, ...change } : r)));

  return (
    <section className="grid gap-3" aria-labelledby="import-heading">
      <h2 id="import-heading" className="text-section font-semibold">
        Import from another assistant
      </h2>
      <div className="grid gap-2 sm:max-w-xs">
        <Field label="Assistant">
          {(props) => (
            <select
              {...props}
              className="h-8 rounded-md border border-control bg-bg-raised px-2 text-ui text-fg"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              {PROVIDERS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <p className="text-dense text-fg-muted">
        Paste this into {provider}, then save its answer as a CSV file and upload it here.
      </p>
      <div className="flex items-start gap-2">
        <code className="flex-1 rounded-md border border-border bg-bg-raised p-2 text-dense">
          {EXPORT_PROMPT}
        </code>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            navigator.clipboard?.writeText(EXPORT_PROMPT).then(
              () => toast.success("Copied."),
              () => undefined,
            )
          }
        >
          Copy prompt
        </Button>
      </div>
      <Field
        label="CSV file"
        hint="Header text,category,created_at,source_platform; up to 1,000 rows."
      >
        {(props) => (
          <Input
            {...props}
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={(e) => {
              choose(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        )}
      </Field>
      {preview && (
        <div className="grid gap-3">
          {preview.would_exceed_cap > 0 && (
            <p role="alert" className="text-destructive">
              Importing all of these would go {preview.would_exceed_cap} over your memory limit. The
              import stops at the limit and skips the rest.
            </p>
          )}
          <table className="w-full text-dense">
            <caption className="sr-only">Memories found in the file</caption>
            <thead>
              <tr className="text-left text-fg-muted">
                <th scope="col" className="w-16">
                  Keep
                </th>
                <th scope="col" className="w-14">
                  Line
                </th>
                <th scope="col">Memory</th>
                <th scope="col" className="w-28">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.line} className="border-t border-border align-top">
                  <td>
                    <Checkbox
                      aria-label={`Keep line ${r.line}`}
                      checked={r.keep}
                      disabled={r.status !== "ok"}
                      onCheckedChange={(v) => set(r.line, { keep: v === true })}
                    />
                  </td>
                  <td>{r.line}</td>
                  <td>
                    {r.status === "ok" ? (
                      <Input
                        aria-label={`Text for line ${r.line}`}
                        value={r.text}
                        onChange={(e) => set(r.line, { text: e.target.value, edited: true })}
                      />
                    ) : (
                      <span>{r.text}</span>
                    )}
                  </td>
                  <td>
                    {r.status === "error"
                      ? `Error: ${r.error ?? "can't be read"}`
                      : r.status === "duplicate"
                        ? "Already saved"
                        : r.keep
                          ? "Keep"
                          : "Skip"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-2">
            <Button disabled={busy || keeping === 0} onClick={commit}>
              Import selected ({keeping})
            </Button>
            <Button variant="quiet" onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
