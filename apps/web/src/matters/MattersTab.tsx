import type { ImportMode, ImportPreview, MatterCreate } from "@legallabs/contracts";
import {
  Button,
  Checkbox,
  DataTable,
  Field,
  Input,
  Label,
  NativeSelect,
  type TableColumn,
  Textarea,
  toast,
} from "@legallabs/ui";
import { type FormEvent, useState } from "react";
import { type Matter, type MatterOptions, matterApi, messageOf } from "./api.js";

const BLANK: MatterCreate = {
  client_id: "",
  client_name: "",
  matter_number: "",
  matter_name: "",
};

const columns: TableColumn<Matter>[] = [
  { id: "display", header: "Matter", cell: (m) => m.display, sortValue: (m) => m.display },
  { id: "client", header: "Client", cell: (m) => m.client_name, sortValue: (m) => m.client_name },
  { id: "name", header: "Name", cell: (m) => m.matter_name },
  { id: "notice", header: "Notice", cell: (m) => (m.notice_md ? "Yes" : "No"), width: 90 },
  {
    id: "queries",
    header: "In queries",
    cell: (m) => (m.allow_in_queries ? "Yes" : "No"),
    width: 110,
  },
  {
    id: "retention",
    header: "Retention",
    cell: (m) => (m.retention_hours === null ? "Default" : `${m.retention_hours} h`),
    width: 110,
  },
  { id: "source", header: "Source", cell: (m) => m.source, width: 100 },
  {
    id: "walls",
    header: "Walls",
    cell: (m) => String(m.walls_count ?? 0),
    sortValue: (m) => m.walls_count ?? 0,
    align: "end",
    width: 80,
  },
  { id: "status", header: "Status", cell: (m) => m.status, width: 90 },
];

export type MattersPanel =
  | { kind: "add" }
  | { kind: "import" }
  | { kind: "options" }
  | { kind: "matter"; matter: Matter };

export function MattersTable({
  matters,
  query,
  onQuery,
  onOpen,
}: {
  matters: Matter[] | null;
  query: string;
  onQuery: (q: string) => void;
  onOpen: (matter: Matter) => void;
}) {
  return (
    <div className="grid gap-3">
      <Input
        type="search"
        aria-label="Search matters"
        placeholder="Search by client or matter id and name"
        className="max-w-md"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      <DataTable
        label="Matters"
        columns={columns}
        rows={matters ?? []}
        loading={matters === null}
        getRowId={(m) => m.id}
        onActivate={onOpen}
        empty="No matters yet. Add one, or import a CSV."
      />
    </div>
  );
}

export function AddMatterForm({ onSaved }: { onSaved: (matter: Matter) => void }) {
  const [form, setForm] = useState<MatterCreate>(BLANK);
  const [notice, setNotice] = useState("");
  const [allowList, setAllowList] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof MatterCreate) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const matter = await matterApi.create({
        ...form,
        ...(notice.trim() ? { notice_md: notice } : {}),
        wall_mode: allowList ? "allow_list" : "open",
      });
      toast.success(`Added ${matter.display}`);
      onSaved(matter);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const text = (key: keyof MatterCreate, label: string, max: number) => (
    <Field label={label}>
      {(props) => (
        <Input
          {...props}
          required
          maxLength={max}
          value={String(form[key] ?? "")}
          onChange={set(key)}
        />
      )}
    </Field>
  );

  return (
    <form onSubmit={submit} className="grid gap-3">
      {text("client_id", "Client id", 64)}
      {text("client_name", "Client name", 200)}
      {text("matter_number", "Matter number", 64)}
      {text("matter_name", "Matter name", 200)}
      <Field label="Notice" hint="Shown once to each person who picks this matter.">
        {(props) => (
          <Textarea
            {...props}
            maxLength={5000}
            value={notice}
            onChange={(e) => setNotice(e.target.value)}
          />
        )}
      </Field>
      <div className="flex items-center gap-2">
        <Checkbox
          id="allow-list"
          checked={allowList}
          onCheckedChange={(v) => setAllowList(v === true)}
        />
        <Label htmlFor="allow-list">Allow-listed: only people on its walls may see it</Label>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy} className="justify-self-start">
        {busy ? "Adding…" : "Add matter"}
      </Button>
    </form>
  );
}

/** Edits one matter's notice and switches; saving new notice text shows it to everyone again. */
export function MatterEditor({
  matter,
  onSaved,
}: {
  matter: Matter;
  onSaved: (matter: Matter) => void;
}) {
  const [notice, setNotice] = useState(matter.notice_md ?? "");
  const [inQueries, setInQueries] = useState(matter.allow_in_queries);
  const [requireWalls, setRequireWalls] = useState(matter.require_walls_for_sharing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<Matter>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await work();
      toast.success(done);
      onSaved(saved);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(
      () =>
        matterApi.update(matter.id, {
          notice_md: notice.trim() ? notice : null,
          allow_in_queries: inQueries,
          require_walls_for_sharing: requireWalls,
        }),
      "Matter saved",
    );
  };

  return (
    <form onSubmit={save} className="grid gap-3">
      <p className="text-ui text-fg-muted">
        {matter.client_name} · {matter.matter_name} · notice version {matter.notice_version}
      </p>
      <Field
        label="Notice"
        hint="Changing the text shows it again to everyone, once, before they can use the matter."
      >
        {(props) => (
          <Textarea
            {...props}
            rows={6}
            maxLength={5000}
            value={notice}
            onChange={(e) => setNotice(e.target.value)}
          />
        )}
      </Field>
      <div className="flex items-center gap-2">
        <Checkbox
          id="in-queries"
          checked={inQueries}
          onCheckedChange={(v) => setInQueries(v === true)}
        />
        <Label htmlFor="in-queries">Offer in the matter picker</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="require-walls"
          checked={requireWalls}
          onCheckedChange={(v) => setRequireWalls(v === true)}
        />
        <Label htmlFor="require-walls">Require walls for sharing</Label>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          Save
        </Button>
        {matter.status === "active" && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void run(() => matterApi.close(matter.id), "Matter closed")}
          >
            Close matter
          </Button>
        )}
      </div>
    </form>
  );
}

export function ImportMatters({ onApplied }: { onApplied: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<ImportMode>("upsert");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      setPreview(await matterApi.importPreview(file, mode));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await matterApi.importApply(preview.token);
      setReport(result.report_csv);
      setPreview(null);
      toast.success(
        `Imported: ${result.applied.add} added, ${result.applied.update} updated, ${result.applied.close} closed`,
      );
      onApplied();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      <form onSubmit={check} className="grid gap-3">
        <Field label="CSV file" hint="Columns: client_id, client_name, matter_number, matter_name.">
          {(props) => (
            <Input
              {...props}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
              }}
            />
          )}
        </Field>
        <Field label="Mode">
          {(props) => (
            <NativeSelect
              {...props}
              value={mode}
              onChange={(e) => setMode(e.target.value as ImportMode)}
            >
              <option value="upsert">Add and update</option>
              <option value="replace_missing_as_closed">Also close matters not in the file</option>
            </NativeSelect>
          )}
        </Field>
        <Button type="submit" disabled={!file || busy} className="justify-self-start">
          Preview
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {preview && (
        <section aria-label="Import preview" className="grid gap-2">
          <p>
            {preview.add} to add, {preview.update} to update, {preview.close} to close,{" "}
            {preview.unchanged} unchanged, {preview.issue_count} with problems.
          </p>
          {preview.issues.length > 0 && (
            <ul className="grid gap-1 text-dense">
              {preview.issues.map((issue) => (
                <li key={`${issue.line}-${issue.column}`}>
                  Line {issue.line}
                  {issue.column ? ` (${issue.column})` : ""}: {issue.message}
                </li>
              ))}
            </ul>
          )}
          <Button onClick={apply} disabled={busy} className="justify-self-start">
            Apply import
          </Button>
        </section>
      )}
      {report && (
        <a
          className="text-accent underline"
          download="matter-import-result.csv"
          href={`data:text/csv;charset=utf-8,${encodeURIComponent(report)}`}
        >
          Download the result
        </a>
      )}
    </div>
  );
}

export function OptionsForm({
  options,
  onSaved,
}: {
  options: MatterOptions;
  onSaved: (options: MatterOptions) => void;
}) {
  const [draft, setDraft] = useState(options);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flag = (key: "require_for_queries" | "user_editable", label: string) => (
    <div className="flex items-center gap-2">
      <Checkbox
        id={`option-${key}`}
        checked={draft[key]}
        onCheckedChange={(v) => setDraft({ ...draft, [key]: v === true })}
      />
      <Label htmlFor={`option-${key}`}>{label}</Label>
    </div>
  );
  const format = draft.display_format;
  const formatFlag = (
    key: "show_client_id" | "show_client_name" | "show_description",
    label: string,
  ) => (
    <div className="flex items-center gap-2">
      <Checkbox
        id={`format-${key}`}
        checked={format[key]}
        onCheckedChange={(v) =>
          setDraft({ ...draft, display_format: { ...format, [key]: v === true } })
        }
      />
      <Label htmlFor={`format-${key}`}>{label}</Label>
    </div>
  );

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await matterApi.setOptions({
        ...draft,
        id_regex: draft.id_regex?.trim() ? draft.id_regex : null,
        sharing_warning: draft.sharing_warning?.trim() ? draft.sharing_warning : null,
      });
      toast.success("Options saved");
      onSaved(saved);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="grid gap-3">
      {flag("require_for_queries", "Require a matter for every question")}
      {flag("user_editable", "Let people create and edit their own matters")}
      <Field label="Vault association">
        {(props) => (
          <NativeSelect
            {...props}
            value={draft.vault_association}
            onChange={(e) =>
              setDraft({
                ...draft,
                vault_association: e.target.value as MatterOptions["vault_association"],
              })
            }
          >
            <option value="disabled">Disabled</option>
            <option value="optional">Optional</option>
            <option value="required">Required</option>
          </NativeSelect>
        )}
      </Field>
      <Field label="Separator">
        {(props) => (
          <Input
            {...props}
            maxLength={3}
            value={format.separator}
            onChange={(e) =>
              setDraft({ ...draft, display_format: { ...format, separator: e.target.value } })
            }
          />
        )}
      </Field>
      {formatFlag("show_client_id", "Show the client id")}
      {formatFlag("show_client_name", "Show the client name")}
      {formatFlag("show_description", "Show the description")}
      <Field label="Matter number pattern" hint="A regular expression, like ^\d{5}-\d{4}$.">
        {(props) => (
          <Input
            {...props}
            maxLength={200}
            value={draft.id_regex ?? ""}
            onChange={(e) => setDraft({ ...draft, id_regex: e.target.value })}
          />
        )}
      </Field>
      <Field label="Sharing warning" hint="Up to 200 characters, shown when sharing matter work.">
        {(props) => (
          <Input
            {...props}
            maxLength={200}
            value={draft.sharing_warning ?? ""}
            onChange={(e) => setDraft({ ...draft, sharing_warning: e.target.value })}
          />
        )}
      </Field>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy} className="justify-self-start">
        Save options
      </Button>
    </form>
  );
}
