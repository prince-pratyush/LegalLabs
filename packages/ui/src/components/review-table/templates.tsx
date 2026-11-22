import { TEMPLATE_LIMITS } from "@legallabs/contracts";
import { Dialog } from "radix-ui";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "../button.js";
import { Checkbox } from "../checkbox.js";
import { Field, Input, Textarea } from "../field.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../select.js";
import { SidePanel } from "../side-panel.js";
import { Skeleton } from "../status.js";
import type { VaultTree } from "./create-table.js";

export type TemplateStatus =
  | "draft"
  | "tested"
  | "shared"
  | "pending_approval"
  | "published"
  | "rejected"
  | "superseded";

/** What the list needs of a template. */
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  categories: string[];
  status: TemplateStatus;
  version: number;
  columns: { key: string; label: string }[];
  my_access: "owner" | "edit" | "use";
  rejected_note: string | null;
}

export const TEMPLATE_STATUS_TEXT: Record<TemplateStatus, string> = {
  draft: "Draft",
  tested: "Tested",
  shared: "Shared",
  pending_approval: "Waiting for approval",
  published: "Published",
  rejected: "Rejected",
  superseded: "Replaced",
};

const tags = (text: string) =>
  text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

export interface SaveTemplateRequest {
  name: string;
  description: string;
  categories: string[];
  document_tags: string[];
}

/** Save a table's columns and settings as a template; the rows and source stay behind. */
export function SaveTemplateDialog({
  open,
  onOpenChange,
  defaultName,
  columnCount,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  columnCount: number;
  onSave: (request: SaveTemplateRequest) => Promise<void>;
}) {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState("");
  const [categories, setCategories] = useState("");
  const [documentTags, setDocumentTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setError(null);
    }
  }, [open, defaultName]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError("Name the template.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        categories: tags(categories),
        document_tags: tags(documentTags),
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the template. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-fg/40 data-[state=open]:animate-fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 grid w-[min(28rem,calc(100vw-2rem))] -translate-1/2 gap-3 rounded-lg border border-border bg-bg-raised p-6 text-fg shadow-xl data-[state=open]:animate-fade-in">
          <Dialog.Title className="text-section font-semibold">Save as template</Dialog.Title>
          <Dialog.Description className="text-ui text-fg-muted">
            Keeps this table's {columnCount} {columnCount === 1 ? "column" : "columns"},
            instructions and settings. Rows, answers and the source stay here.
          </Dialog.Description>
          <form onSubmit={submit} className="grid gap-3">
            <Field label="Name">
              {(props) => (
                <Input
                  {...props}
                  value={name}
                  maxLength={120}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
            <Field label="Description">
              {(props) => (
                <Textarea
                  {...props}
                  rows={2}
                  maxLength={1000}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              )}
            </Field>
            <Field label="Practice areas" hint="Separate with commas.">
              {(props) => (
                <Input
                  {...props}
                  value={categories}
                  onChange={(e) => setCategories(e.target.value)}
                />
              )}
            </Field>
            <Field label="Document types" hint="For example: credit agreement, lease.">
              {(props) => (
                <Input
                  {...props}
                  value={documentTags}
                  onChange={(e) => setDocumentTags(e.target.value)}
                />
              )}
            </Field>
            {error && (
              <p role="alert" className="text-caption text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save template"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface TemplateActions {
  onUse: (t: TemplateSummary) => void;
  onTest: (t: TemplateSummary) => void;
  onShare: (t: TemplateSummary) => void;
  onPublish: (t: TemplateSummary) => void;
  onApprove: (t: TemplateSummary) => void;
  onReject: (t: TemplateSummary) => void;
  onDelete: (t: TemplateSummary) => void;
}

/** Templates with where each stands and what the viewer can do next. */
export function TemplateList({
  templates,
  loading = false,
  ...actions
}: { templates: TemplateSummary[]; loading?: boolean } & TemplateActions) {
  if (loading) {
    return (
      <div aria-hidden className="grid gap-2">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    );
  }
  if (templates.length === 0) {
    return (
      <p className="text-fg-muted">
        No templates yet. Open a table and choose Save as template to make one.
      </p>
    );
  }
  return (
    <ul className="grid gap-2">
      {templates.map((t) => {
        const mine = t.my_access !== "use";
        return (
          <li key={t.id} className="grid gap-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">{t.name}</h3>
              <span className="rounded-sm bg-bg-subtle px-1.5 text-caption text-fg-muted">
                {TEMPLATE_STATUS_TEXT[t.status]}
              </span>
              {t.version > 1 && <span className="text-caption text-fg-muted">v{t.version}</span>}
            </div>
            {t.description && <p className="text-dense text-fg-muted">{t.description}</p>}
            <p className="text-caption text-fg-muted">
              {t.columns.length} {t.columns.length === 1 ? "column" : "columns"}
              {t.categories.length > 0 ? ` · ${t.categories.join(", ")}` : ""}
            </p>
            {t.status === "rejected" && t.rejected_note && (
              <p className="text-caption text-destructive">Rejected: {t.rejected_note}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" aria-label={`Use ${t.name}`} onClick={() => actions.onUse(t)}>
                Use
              </Button>
              {mine && t.status !== "pending_approval" && (
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Test ${t.name}`}
                  onClick={() => actions.onTest(t)}
                >
                  Test
                </Button>
              )}
              {t.my_access === "owner" && (
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Share ${t.name}`}
                  onClick={() => actions.onShare(t)}
                >
                  Share
                </Button>
              )}
              {mine && (t.status === "tested" || t.status === "shared") && (
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Ask for approval of ${t.name}`}
                  onClick={() => actions.onPublish(t)}
                >
                  Ask for approval
                </Button>
              )}
              {t.status === "pending_approval" && t.my_access === "edit" && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Approve ${t.name}`}
                    onClick={() => actions.onApprove(t)}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Reject ${t.name}`}
                    onClick={() => actions.onReject(t)}
                  >
                    Reject
                  </Button>
                </>
              )}
              {mine && (
                <Button
                  size="sm"
                  variant="quiet"
                  aria-label={`Delete ${t.name}`}
                  onClick={() => actions.onDelete(t)}
                >
                  Delete
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Pick a vault and up to ten of its files to try a template on. */
export function TestTemplatePanel({
  templateName,
  vaults,
  loadTree,
  limit = TEMPLATE_LIMITS.testDocuments,
  onTest,
  onClose,
}: {
  templateName: string;
  vaults: { id: string; name: string }[];
  loadTree: (vaultId: string) => Promise<VaultTree>;
  limit?: number;
  onTest: (vaultId: string, documentIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [vaultId, setVaultId] = useState("");
  const [tree, setTree] = useState<VaultTree | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!vaultId) return;
    let live = true;
    setTree(null);
    setPicked(new Set());
    loadTree(vaultId).then(
      (next) => live && setTree(next),
      () => live && setError("Couldn't open that vault."),
    );
    return () => {
      live = false;
    };
  }, [vaultId, loadTree]);

  const toggle = (id: string, on: boolean) =>
    setPicked((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (picked.size === 0) {
      setError("Choose at least one file.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onTest(vaultId, [...picked]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the test. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidePanel title={`Test ${templateName}`} onClose={onClose} width={420}>
      <form onSubmit={submit} className="grid gap-3">
        <p className="text-caption text-fg-muted">
          Makes a table of up to {limit} files with this template's columns and runs it. The test
          table is deleted after a week.
        </p>
        <div className="grid gap-1">
          <span id="test-vault-label" className="text-ui font-medium">
            Vault
          </span>
          <Select value={vaultId} onValueChange={setVaultId}>
            <SelectTrigger aria-labelledby="test-vault-label">
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
        {tree && (
          <fieldset className="grid max-h-72 gap-1 overflow-y-auto">
            <legend className="mb-1 text-caption text-fg-muted">
              {picked.size} of {limit} files chosen.
            </legend>
            {tree.files.map((f) => (
              <span key={f.id} className="flex items-center gap-1">
                <Checkbox
                  id={`test-${f.id}`}
                  checked={picked.has(f.id)}
                  disabled={!picked.has(f.id) && picked.size >= limit}
                  onCheckedChange={(value) => toggle(f.id, value === true)}
                />
                <label htmlFor={`test-${f.id}`}>{f.name}</label>
              </span>
            ))}
          </fieldset>
        )}
        {error && (
          <p role="alert" className="text-caption text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? "Starting…" : "Test template"}
        </Button>
      </form>
    </SidePanel>
  );
}
