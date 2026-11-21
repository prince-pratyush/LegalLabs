import { Button, Checkbox, ConfirmDialog, Field, Input, Textarea, toast } from "@legallabs/ui";
import { useCallback, useEffect, useState } from "react";
import { ApiError, messageOf } from "../api.js";
import {
  type Candidate,
  type ImportPreview,
  type Memory,
  type MemoryList,
  memoryApi,
  PERSONALISE_QUESTIONS,
  type MemorySettings as Settings,
} from "./api.js";

export const EXPORT_PROMPT =
  "List every memory you hold about me as CSV with the columns text,category,created_at,source_platform. Put one memory per row, quote any text that contains commas, and include nothing else.";

const PROVIDERS = ["ChatGPT", "Claude", "Gemini", "Copilot", "Perplexity", "Other"];

/** What the assistant remembers about you: yours to read, change and delete. */
export function MemorySettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [denied, setDenied] = useState(false);
  const [list, setList] = useState<MemoryList | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    memoryApi.list(query).then(setList, (err) => setError(messageOf(err)));
    memoryApi.candidates().then(setCandidates, () => undefined);
  }, [query]);

  useEffect(() => {
    memoryApi.settings().then(
      (s) => (s.permitted ? setSettings(s) : setDenied(true)),
      (err) =>
        err instanceof ApiError && err.code === "NOT_ENABLED"
          ? setDenied(true)
          : setError(messageOf(err)),
    );
  }, []);
  useEffect(() => {
    if (settings) refresh();
  }, [settings, refresh]);

  if (denied) {
    return (
      <section className="grid max-w-2xl gap-2" aria-labelledby="memory-heading">
        <h2 id="memory-heading" className="text-section font-semibold">
          Memory
        </h2>
        <p>Not enabled for your role</p>
        <p className="text-dense text-fg-muted">Ask a workspace admin to turn memory on for you.</p>
      </section>
    );
  }
  if (error && !settings) return <p role="alert">{error}</p>;
  if (!settings) return <p role="status">Loading memory settings</p>;

  const fail = (err: unknown) => toast.error(messageOf(err));
  const conflicted = new Set(
    (list?.items ?? []).filter((m) => m.conflicts_with?.length).map((m) => m.id),
  );

  return (
    <div className="grid max-w-3xl gap-8">
      <section className="grid gap-3" aria-labelledby="memory-heading">
        <h2 id="memory-heading" className="text-section font-semibold">
          Memory
        </h2>
        <div className="flex items-start gap-2">
          <Checkbox
            id="use-memory"
            aria-label="Use memory in responses"
            checked={settings.use_memory}
            onCheckedChange={(value) => memoryApi.setUse(value === true).then(setSettings, fail)}
          />
          <label htmlFor="use-memory" className="grid text-ui">
            Use memory in responses
            <span className="text-caption text-fg-muted">
              Turn this off and no memory is sent with your questions. Only you can see your
              memories; admins can't.
            </span>
          </label>
        </div>
        {list && (
          <p className="text-dense text-fg-muted">
            {list.count} of {list.limit} memories used.
          </p>
        )}
      </section>

      {candidates.length > 0 && (
        <section className="grid gap-2" aria-labelledby="candidates-heading">
          <h2 id="candidates-heading" className="text-section font-semibold">
            Suggested memories
          </h2>
          <ul className="grid gap-2" aria-label="Suggested memories">
            {candidates.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3"
              >
                <span className="min-w-0 flex-1">{c.text}</span>
                <Button
                  size="sm"
                  aria-label={`Save as memory: ${c.text}`}
                  onClick={() => memoryApi.accept(c.id).then(refresh, fail)}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  aria-label={`Dismiss: ${c.text}`}
                  onClick={() => memoryApi.dismiss(c.id).then(refresh, fail)}
                >
                  Dismiss
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <CreateMemory onCreated={refresh} />

      <section className="grid gap-3" aria-labelledby="list-heading">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="list-heading" className="text-section font-semibold">
            Your memories
          </h2>
          <div className="ml-auto flex gap-2">
            <Button asChild variant="secondary" size="sm">
              <a href={memoryApi.exportUrl} download="memories.csv">
                Export memories
              </a>
            </Button>
            <ConfirmDialog
              trigger={
                <Button variant="quiet" size="sm" disabled={!list || list.count === 0}>
                  Delete all
                </Button>
              }
              title="Delete all memories?"
              description="Every memory is deleted for good. This can't be undone."
              confirmLabel="Delete all memories"
              destructive
              onConfirm={() =>
                memoryApi.removeAll().then(() => {
                  toast.success("All memories deleted.");
                  refresh();
                }, fail)
              }
            />
          </div>
        </div>
        <Field label="Search memories">
          {(props) => (
            <Input
              {...props}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
        </Field>
        {list === null ? (
          <p role="status">Loading memories</p>
        ) : list.items.length === 0 ? (
          <p className="text-fg-muted">
            {query ? "No memory matches that search." : "No memories yet. Add one above."}
          </p>
        ) : (
          <ul className="grid gap-2" aria-label="Memories">
            {list.items.map((m) => (
              <MemoryRow
                key={m.id}
                memory={m}
                conflict={conflicted.has(m.id)}
                onChanged={refresh}
              />
            ))}
          </ul>
        )}
      </section>

      <Personalise onSaved={refresh} />
      <ImportMemories onImported={refresh} />
    </div>
  );
}

function CreateMemory({ onCreated }: { onCreated: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await memoryApi.create(text.trim());
      setText("");
      onCreated();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid gap-2" aria-labelledby="create-heading">
      <h2 id="create-heading" className="text-section font-semibold">
        Create memory
      </h2>
      <Field
        label="New memory"
        hint="Up to 1,000 characters, e.g. I prefer British spelling."
        error={error}
      >
        {(props) => (
          <Textarea {...props} rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        )}
      </Field>
      <Button className="justify-self-start" disabled={busy || !text.trim()} onClick={add}>
        Add memory
      </Button>
    </section>
  );
}

function MemoryRow({
  memory,
  conflict,
  onChanged,
}: {
  memory: Memory;
  conflict: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.text);
  const fail = (err: unknown) => toast.error(messageOf(err));
  if (editing) {
    return (
      <li className="grid gap-2 rounded-md border border-border p-3">
        <Textarea
          aria-label="Memory text"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!text.trim()}
            onClick={() =>
              memoryApi.update(memory.id, text.trim()).then(() => {
                setEditing(false);
                onChanged();
              }, fail)
            }
          >
            Save
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </li>
    );
  }
  return (
    <li className="grid gap-1 rounded-md border border-border p-3">
      <p>{memory.text}</p>
      <div className="flex flex-wrap items-center gap-2 text-caption text-fg-muted">
        <span>{memory.source}</span>
        {conflict && (
          <>
            <span role="status" className="text-destructive">
              Conflicts with another memory
            </span>
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Resolve: ${memory.text}`}
              onClick={() => setEditing(true)}
            >
              Resolve
            </Button>
          </>
        )}
        <span className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant="quiet"
            aria-label={`Edit: ${memory.text}`}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="quiet"
            aria-label={`Delete: ${memory.text}`}
            onClick={() => memoryApi.remove(memory.id).then(onChanged, fail)}
          >
            Delete
          </Button>
        </span>
      </div>
    </li>
  );
}

function Personalise({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [proposals, setProposals] = useState<{ text: string; keep: boolean }[] | null>(null);
  const [busy, setBusy] = useState(false);

  const suggest = async () => {
    setBusy(true);
    try {
      const given = Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim()));
      const out = await memoryApi.personalise(given);
      setProposals(out.map((p) => ({ text: p.text, keep: true })));
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      for (const p of (proposals ?? []).filter((x) => x.keep)) await memoryApi.create(p.text);
      toast.success("Memories saved.");
      setProposals(null);
      setOpen(false);
      setAnswers({});
      onSaved();
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-2" aria-labelledby="personalise-heading">
      <h2 id="personalise-heading" className="text-section font-semibold">
        Personalise
      </h2>
      {!open ? (
        <>
          <p className="text-dense text-fg-muted">
            Answer six short questions and confirm the memories we propose.
          </p>
          <Button className="justify-self-start" variant="secondary" onClick={() => setOpen(true)}>
            Start personalising
          </Button>
        </>
      ) : proposals === null ? (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            suggest();
          }}
        >
          {PERSONALISE_QUESTIONS.map((q) => (
            <Field key={q.key} label={q.label}>
              {(props) => (
                <Input
                  {...props}
                  value={answers[q.key] ?? ""}
                  maxLength={500}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}
                />
              )}
            </Field>
          ))}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || Object.values(answers).every((v) => !v.trim())}>
              Suggest memories
            </Button>
            <Button type="button" variant="quiet" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="grid gap-3">
          <p className="text-dense text-fg-muted">
            Keep the ones that are right. Nothing is saved until you confirm.
          </p>
          {proposals.length === 0 ? (
            <p>No memories to propose from those answers.</p>
          ) : (
            <ul className="grid gap-2" aria-label="Proposed memories">
              {proposals.map((p, i) => (
                <li key={p.text} className="flex items-start gap-2">
                  <Checkbox
                    aria-label={`Keep: ${p.text}`}
                    checked={p.keep}
                    onCheckedChange={(v) =>
                      setProposals(
                        (all) =>
                          all?.map((x, j) => (j === i ? { ...x, keep: v === true } : x)) ?? all,
                      )
                    }
                  />
                  <span>{p.text}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Button disabled={busy || !proposals.some((p) => p.keep)} onClick={save}>
              Save selected memories
            </Button>
            <Button variant="quiet" onClick={() => setProposals(null)}>
              Back
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

interface Review {
  line: number;
  text: string;
  edited: boolean;
  keep: boolean;
  status: "ok" | "duplicate" | "error";
  error?: string | undefined;
}

function ImportMemories({ onImported }: { onImported: () => void }) {
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
