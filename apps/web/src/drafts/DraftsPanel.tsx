import {
  Button,
  Checkbox,
  type DiffOp,
  DraftPane,
  DraftPaneSkeleton,
  EmptyState,
  PANEL_MAX,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SidePanel,
  Textarea,
} from "@legallabs/ui";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { api, type Draft, messageOf } from "../api.js";

/** Hands the browser a file to save, without leaving the page. */
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const fileName = (title: string) =>
  `${title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Draft"}.docx`;

export function DraftsPanel({
  threadId,
  draftId: initialId,
  onClose,
}: {
  threadId: string;
  /** The draft to show first, e.g. one just made from an answer. */
  draftId?: string;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(PANEL_MAX);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initialId ?? null);
  const [versionNo, setVersionNo] = useState(0);
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [showEdits, setShowEdits] = useState(false);
  const [ops, setOps] = useState<DiffOp[]>([]);
  const [instruction, setInstruction] = useState("");
  const [tracked, setTracked] = useState(true);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const instructionId = useId();
  const trackedId = useId();

  const draft = drafts?.find((d) => d.id === selected) ?? drafts?.[0] ?? null;
  const latest = draft?.latest.no ?? 0;

  const load = useCallback(() => {
    setLoadError(null);
    api.drafts(threadId).then(setDrafts, (err) => setLoadError(messageOf(err)));
  }, [threadId]);
  useEffect(load, [load]);

  // A new draft (or a new version of it) opens at its latest version.
  const draftKey = draft ? `${draft.id}:${draft.latest.no}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: draftKey stands for the draft
  useEffect(() => {
    if (!draft) return;
    setVersionNo(draft.latest.no);
    setBody(draft.latest.body);
    setDirty(false);
  }, [draftKey]);

  // An older version is fetched on demand; the latest arrives with the draft.
  useEffect(() => {
    if (!draft || versionNo === 0 || versionNo === draft.latest.no) return;
    let live = true;
    api.draftVersion(draft.id, versionNo).then(
      (text) => live && setBody(text),
      (err) => live && setError(messageOf(err)),
    );
    return () => {
      live = false;
    };
  }, [draft, versionNo]);

  useEffect(() => {
    if (!draft || !showEdits || versionNo <= 1) return;
    let live = true;
    api.draftDiff(draft.id, versionNo - 1, versionNo).then(
      (diff) => live && setOps(diff.ops),
      (err) => live && setError(messageOf(err)),
    );
    return () => {
      live = false;
    };
  }, [draft, showEdits, versionNo]);

  const replace = (next: Draft) => {
    setDrafts((list) => list?.map((d) => (d.id === next.id ? next : d)) ?? [next]);
    setSelected(next.id);
  };

  // Each change is one call that returns the draft with its new version.
  const run = async (change: () => Promise<Draft>) => {
    setBusy(true);
    setError(null);
    try {
      replace(await change());
      return true;
    } catch (err) {
      setError(messageOf(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const askForEdits = async (event: FormEvent) => {
    event.preventDefault();
    const text = instruction.trim();
    if (!draft || !text) return;
    if (await run(() => api.editDraft(draft.id, text))) setInstruction("");
  };

  const exportWord = async () => {
    if (!draft) return;
    setExporting(true);
    setError(null);
    try {
      const from = tracked && latest > 1 ? 1 : undefined;
      download(await api.exportDraft(draft.id, from), fileName(draft.title));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setExporting(false);
    }
  };

  const readOnly = draft?.read_only ?? true;

  return (
    <SidePanel title="Drafts" onClose={onClose} width={width} onWidthChange={setWidth}>
      {loadError ? (
        <div role="alert" className="grid justify-items-start gap-2">
          <p className="text-ui">{loadError}</p>
          <Button size="sm" onClick={load}>
            Try again
          </Button>
        </div>
      ) : !drafts ? (
        <DraftPaneSkeleton />
      ) : !draft ? (
        <EmptyState
          title="No drafts yet"
          description="Choose “Draft from this answer” under an answer to start one."
          action={{ label: "Close drafts", onClick: onClose }}
        />
      ) : (
        <div className="grid gap-3">
          {drafts.length > 1 && (
            <Select value={draft.id} onValueChange={setSelected}>
              <SelectTrigger aria-label="Draft" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {drafts.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {readOnly && (
            <p role="note" className="text-dense text-fg-muted">
              This draft was shared with you, so it's read-only.
            </p>
          )}
          {error && (
            <p role="alert" className="text-dense text-destructive">
              {error}
            </p>
          )}
          <DraftPane
            title={draft.title}
            kind={draft.kind}
            versions={draft.versions.map((v) => ({
              no: v.no,
              author: v.author,
              createdAt: v.created_at,
            }))}
            versionNo={versionNo || latest}
            onVersion={(no) => {
              setVersionNo(no);
              setDirty(false);
              if (no === latest) setBody(draft.latest.body);
            }}
            showEdits={showEdits}
            onShowEdits={setShowEdits}
            ops={ops}
            body={body}
            onBody={(text) => {
              setBody(text);
              setDirty(true);
            }}
            onRestore={() => void run(() => api.restoreDraft(draft.id, versionNo))}
            onExport={exportWord}
            exporting={exporting}
            readOnly={readOnly}
          />
          <div className="flex flex-wrap items-center gap-3">
            {!readOnly && (
              <Button
                variant={dirty ? "primary" : "secondary"}
                size="sm"
                disabled={!dirty || busy}
                onClick={() => void run(() => api.saveDraft(draft.id, body))}
              >
                {dirty ? "Save as a new version" : "Saved"}
              </Button>
            )}
            {latest > 1 && (
              <span className="flex items-center gap-1">
                <Checkbox
                  id={trackedId}
                  checked={tracked}
                  onCheckedChange={(on) => setTracked(on === true)}
                />
                <label htmlFor={trackedId} className="text-dense">
                  Export edits since v1 as tracked changes
                </label>
              </span>
            )}
          </div>
          {!readOnly && (
            <form onSubmit={askForEdits} className="grid gap-2 border-t border-border pt-3">
              <label htmlFor={instructionId} className="text-ui font-medium">
                Ask for edits
              </label>
              <Textarea
                id={instructionId}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                maxLength={4000}
                rows={2}
                placeholder="Tighten the indemnity and cap it at twelve months of fees."
              />
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || dirty || !instruction.trim() || versionNo !== latest}
                >
                  {busy ? "Working…" : "Edit the draft"}
                </Button>
                {dirty && (
                  <span className="text-caption text-fg-muted">Save your changes first.</span>
                )}
              </div>
            </form>
          )}
        </div>
      )}
    </SidePanel>
  );
}
