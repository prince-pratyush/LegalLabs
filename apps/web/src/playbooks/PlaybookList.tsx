import type { PlaybookCreate, PlaybookSummary } from "@legallabs/contracts";
import {
  Button,
  type Choice,
  CreatePlaybookForm,
  CreatePlaybookFormSkeleton,
  Input,
  PANEL_MIN,
  PlaybookTable,
  SidePanel,
} from "@legallabs/ui";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { api, messageOf } from "../api.js";
import { type ListFilter, playbookApi } from "./api.js";
import { goPlaybooks } from "./route.js";

const STATUSES: { value: ListFilter["status"]; label: string }[] = [
  { value: undefined, label: "All" },
  { value: "published", label: "Published" },
  { value: "unpublished", label: "Unpublished" },
];

export function PlaybookList({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<ListFilter["status"]>();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<PlaybookSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let live = true;
    // A short pause, so typing a search doesn't send a request per key.
    const timer = setTimeout(() => {
      playbookApi
        .list({ ...(status ? { status } : {}), ...(q.trim() ? { q: q.trim() } : {}) })
        .then(
          (items) => live && setRows(items),
          (err) => live && setError(messageOf(err)),
        );
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [status, q]);

  return (
    <div className="flex min-w-0 flex-1 gap-0">
      <div className="grid min-w-0 flex-1 content-start gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-title font-semibold">Playbooks</h1>
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            Create
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <fieldset className="flex gap-1">
            <legend className="sr-only">Status</legend>
            {STATUSES.map((s) => (
              <Button
                key={s.label}
                size="sm"
                variant={status === s.value ? "secondary" : "quiet"}
                aria-pressed={status === s.value}
                onClick={() => setStatus(s.value)}
              >
                {s.label}
              </Button>
            ))}
          </fieldset>
          <Input
            aria-label="Search playbooks"
            placeholder="Search by name or contract type"
            className="max-w-xs"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <PlaybookTable
          rows={rows ?? []}
          loading={rows === null}
          filtered={Boolean(status || q.trim())}
          onOpen={(p) => goPlaybooks({ page: "playbook", playbookId: p.id, version: null })}
          onCreate={() => setCreating(true)}
        />
      </div>
      {creating && (
        <CreatePanel
          copyable={(rows ?? []).map((r) => ({ id: r.id, name: r.name }))}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            onChanged();
            goPlaybooks({ page: "playbook", playbookId: id, version: null });
          }}
        />
      )}
    </div>
  );
}

function CreatePanel({
  copyable,
  onClose,
  onCreated,
}: {
  copyable: Choice[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [width, setWidth] = useState(PANEL_MIN + 40);
  const [documents, setDocuments] = useState<Choice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.documents().then(
      (docs) =>
        setDocuments(
          docs.filter((d) => d.status === "indexed").map((d) => ({ id: d.id, name: d.name })),
        ),
      () => setDocuments([]),
    );
  }, []);

  const submit = async (input: PlaybookCreate) => {
    setBusy(true);
    setError(null);
    try {
      const playbook = await playbookApi.create(input);
      onCreated(playbook.id);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidePanel title="Create a playbook" onClose={onClose} width={width} onWidthChange={setWidth}>
      {documents === null ? (
        <CreatePlaybookFormSkeleton />
      ) : (
        <CreatePlaybookForm
          playbooks={copyable}
          documents={documents}
          busy={busy}
          error={error}
          onSubmit={submit}
          onCancel={onClose}
        />
      )}
    </SidePanel>
  );
}
