import { Upload } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "../button.js";
import { Checkbox } from "../checkbox.js";
import { Field, Input } from "../field.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../select.js";
import { SidePanel } from "../side-panel.js";
import { Skeleton } from "../status.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs.js";

export const MAX_UPLOADS = 50;

export type CreateSource =
  | { kind: "vault"; vault_id: string; folder_ids?: string[]; document_ids?: string[] }
  | { kind: "uploads"; files: File[] }
  | { kind: "thread"; thread_id: string };

export interface CreateRequest {
  name?: string;
  source: CreateSource;
}

export interface VaultTree {
  folders: { id: string; name: string }[];
  files: { id: string; name: string }[];
}

type Mode = "vault" | "uploads" | "thread";

const flip = (set: Set<string>, id: string) => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

/** Create a table from one source: a vault, uploaded files, or a thread's files (RVT-001). */
export function CreateTablePanel({
  vaults,
  threads,
  loadTree,
  onCreate,
  onClose,
  initialThreadId,
}: {
  vaults: { id: string; name: string }[];
  threads: { id: string; title: string }[];
  loadTree: (vaultId: string) => Promise<VaultTree>;
  onCreate: (request: CreateRequest) => Promise<void>;
  onClose: () => void;
  initialThreadId?: string;
}) {
  const [mode, setMode] = useState<Mode>(initialThreadId ? "thread" : "vault");
  const [name, setName] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [tree, setTree] = useState<VaultTree | null>(null);
  const [folders, setFolders] = useState<Set<string>>(new Set());
  const [docs, setDocs] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<File[]>([]);
  const [threadId, setThreadId] = useState(initialThreadId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!vaultId) return;
    let live = true;
    setTree(null);
    setFolders(new Set());
    setDocs(new Set());
    loadTree(vaultId).then(
      (next) => live && setTree(next),
      () => live && setError("Couldn't open that vault."),
    );
    return () => {
      live = false;
    };
  }, [vaultId, loadTree]);

  const source = (): CreateSource | string => {
    if (mode === "vault") {
      if (!vaultId) return "Choose a vault.";
      return {
        kind: "vault",
        vault_id: vaultId,
        ...(folders.size ? { folder_ids: [...folders] } : {}),
        ...(docs.size ? { document_ids: [...docs] } : {}),
      };
    }
    if (mode === "uploads") {
      if (files.length === 0) return "Choose files to upload.";
      if (files.length > MAX_UPLOADS) return `Upload ${MAX_UPLOADS} files or fewer.`;
      return { kind: "uploads", files };
    }
    return threadId ? { kind: "thread", thread_id: threadId } : "Choose a thread.";
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const picked = source();
    if (typeof picked === "string") {
      setError(picked);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate({ ...(name.trim() ? { name: name.trim() } : {}), source: picked });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the table. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidePanel title="New review table" onClose={onClose} width={440}>
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Name" hint="Optional; it's named after the source otherwise.">
          {(props) => (
            <Input
              {...props}
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <p className="text-caption text-fg-muted">
          One table, one source: rows come from a single vault, upload or thread.
        </p>
        <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
          <TabsList>
            <TabsTrigger value="vault">From a vault</TabsTrigger>
            <TabsTrigger value="uploads">Upload files</TabsTrigger>
            <TabsTrigger value="thread">From a thread</TabsTrigger>
          </TabsList>
          <TabsContent value="vault" className="grid gap-3 pt-3">
            <div className="grid gap-1">
              <span id="vault-label" className="text-ui font-medium">
                Vault
              </span>
              <Select value={vaultId} onValueChange={setVaultId}>
                <SelectTrigger aria-labelledby="vault-label">
                  <SelectValue placeholder="Choose a vault" />
                </SelectTrigger>
                <SelectContent>
                  {vaults.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {vaultId && !tree && (
              <div aria-hidden className="grid gap-1">
                <Skeleton className="h-6" />
                <Skeleton className="h-6" />
              </div>
            )}
            {tree && (
              <fieldset className="grid max-h-72 gap-1 overflow-y-auto">
                <legend className="mb-1 text-caption text-fg-muted">
                  Leave everything unticked to use the whole vault.
                </legend>
                {tree.folders.map((f) => (
                  <span key={f.id} className="flex items-center gap-1">
                    <Checkbox
                      id={`folder-${f.id}`}
                      checked={folders.has(f.id)}
                      onCheckedChange={() => setFolders((s) => flip(s, f.id))}
                    />
                    <label htmlFor={`folder-${f.id}`}>{f.name}/</label>
                  </span>
                ))}
                {tree.files.map((f) => (
                  <span key={f.id} className="flex items-center gap-1">
                    <Checkbox
                      id={`doc-${f.id}`}
                      checked={docs.has(f.id)}
                      onCheckedChange={() => setDocs((s) => flip(s, f.id))}
                    />
                    <label htmlFor={`doc-${f.id}`}>{f.name}</label>
                  </span>
                ))}
              </fieldset>
            )}
          </TabsContent>
          <TabsContent value="uploads" className="grid gap-2 pt-3">
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              aria-label="Files to upload"
              onChange={(e) => setFiles([...(e.target.files ?? [])])}
            />
            <Button type="button" variant="secondary" onClick={() => picker.current?.click()}>
              <Upload aria-hidden />
              Choose files (up to {MAX_UPLOADS})
            </Button>
            {files.length > 0 && (
              <ul className="grid max-h-60 gap-1 overflow-y-auto text-dense">
                {files.map((f) => (
                  <li key={`${f.name}-${f.size}`} className="truncate">
                    {f.name}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-caption text-fg-muted">{files.length} chosen.</p>
          </TabsContent>
          <TabsContent value="thread" className="grid gap-1 pt-3">
            <span id="thread-label" className="text-ui font-medium">
              Thread
            </span>
            <Select value={threadId} onValueChange={setThreadId}>
              <SelectTrigger aria-labelledby="thread-label">
                <SelectValue placeholder="Choose a thread" />
              </SelectTrigger>
              <SelectContent>
                {threads.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-caption text-fg-muted">Rows are the thread's documents.</p>
          </TabsContent>
        </Tabs>
        {error && (
          <p role="alert" className="text-caption text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create table"}
        </Button>
      </form>
    </SidePanel>
  );
}
