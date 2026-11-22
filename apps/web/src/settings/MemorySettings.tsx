import { Button, Checkbox, ConfirmDialog, Field, Input, toast } from "@legallabs/ui";
import { useCallback, useEffect, useState } from "react";
import { ApiError, messageOf } from "../api.js";
import {
  type Candidate,
  type MemoryList,
  memoryApi,
  type MemorySettings as Settings,
} from "./api.js";
import { ImportMemories } from "./ImportMemories.js";
import { CreateMemory, MemoryRow } from "./MemoryEditing.js";
import { Personalise } from "./PersonaliseMemory.js";

export { EXPORT_PROMPT } from "./ImportMemories.js";

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
