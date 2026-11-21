import type { ReviewTableTemplate } from "@legallabs/contracts";
import {
  Button,
  type LibraryShare,
  LibraryShareForm,
  LibraryShareFormSkeleton,
  SidePanel,
  TemplateList,
  type TemplateSummary,
  TestTemplatePanel,
  Textarea,
  toast,
} from "@legallabs/ui";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { vaultApi } from "../vaults/api.js";
import { messageOf, tableApi } from "./api.js";
import { goTables } from "./route.js";

type Panel =
  | { kind: "test"; template: ReviewTableTemplate }
  | { kind: "share"; template: ReviewTableTemplate }
  | { kind: "reject"; template: ReviewTableTemplate };

const toSummary = (t: ReviewTableTemplate): TemplateSummary => t;

/** Templates the person owns, has been given, or that the workspace has published. */
export function TemplatesPage() {
  const [templates, setTemplates] = useState<ReviewTableTemplate[] | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [vaults, setVaults] = useState<{ id: string; name: string }[]>([]);

  const load = useCallback(async () => {
    try {
      setTemplates(await tableApi.templates());
    } catch (err) {
      toast.error(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadTree = useCallback(async (vaultId: string) => {
    const tree = await vaultApi.tree(vaultId, {});
    return { folders: tree.folders, files: tree.files };
  }, []);

  const find = (summary: TemplateSummary) => templates?.find((t) => t.id === summary.id);

  const act = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work();
      toast.success(done);
      await load();
    } catch (err) {
      toast.error(messageOf(err));
    }
  };

  return (
    <div className="flex h-dvh">
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        <Button
          variant="quiet"
          size="sm"
          className="mb-4 text-fg-muted"
          onClick={() => goTables({ page: "list", threadId: null })}
        >
          <ArrowLeft aria-hidden />
          Back to review tables
        </Button>
        <h1 className="mb-1 text-section font-semibold">Review table templates</h1>
        <p className="mb-4 text-fg-muted">
          A template keeps a table's columns, instructions and settings, never its rows or source.
        </p>
        <TemplateList
          templates={(templates ?? []).map(toSummary)}
          loading={templates === null}
          onUse={(t) => goTables({ page: "list", threadId: null, templateId: t.id })}
          onTest={(t) => {
            const found = find(t);
            if (!found) return;
            vaultApi.list().then(setVaults, () => setVaults([]));
            setPanel({ kind: "test", template: found });
          }}
          onShare={(t) => {
            const found = find(t);
            if (found) setPanel({ kind: "share", template: found });
          }}
          onPublish={(t) => void act(() => tableApi.publishTemplate(t.id), "Sent for approval.")}
          onApprove={(t) =>
            void act(() => tableApi.decideTemplate(t.id, true), "Template published.")
          }
          onReject={(t) => {
            const found = find(t);
            if (found) setPanel({ kind: "reject", template: found });
          }}
          onDelete={(t) => void act(() => tableApi.deleteTemplate(t.id), "Template deleted.")}
        />
      </main>
      {panel?.kind === "test" && (
        <TestTemplatePanel
          templateName={panel.template.name}
          vaults={vaults}
          loadTree={loadTree}
          onClose={() => setPanel(null)}
          onTest={async (vaultId, documentIds) => {
            try {
              const made = await tableApi.testTemplate(panel.template.id, {
                vault_id: vaultId,
                document_ids: documentIds,
              });
              setPanel(null);
              goTables({ page: "table", tableId: made.table_id });
            } catch (err) {
              throw new Error(messageOf(err));
            }
          }}
        />
      )}
      {panel?.kind === "share" && (
        <SidePanel
          title={`Share ${panel.template.name}`}
          onClose={() => setPanel(null)}
          width={420}
        >
          <TemplateShares templateId={panel.template.id} onChanged={() => void load()} />
        </SidePanel>
      )}
      {panel?.kind === "reject" && (
        <RejectPanel
          name={panel.template.name}
          onClose={() => setPanel(null)}
          onReject={async (note) => {
            await act(
              () => tableApi.decideTemplate(panel.template.id, false, note),
              "Template rejected.",
            );
            setPanel(null);
          }}
        />
      )}
    </div>
  );
}

const toShare = (s: {
  principal_type: LibraryShare["principalType"];
  principal_id: string;
  label: string;
  level: LibraryShare["level"];
}): LibraryShare => ({
  principalType: s.principal_type,
  principalId: s.principal_id,
  label: s.label,
  level: s.level,
});

function TemplateShares({ templateId, onChanged }: { templateId: string; onChanged: () => void }) {
  const [shares, setShares] = useState<LibraryShare[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    tableApi.templateShares(templateId).then(
      (next) => setShares(next.map(toShare)),
      (err) => setError(messageOf(err)),
    );
    fetch("/auth/session", { credentials: "same-origin" })
      .then((res) => res.json() as Promise<{ workspace_id?: string }>)
      .then(
        (s) => setWorkspaceId(s.workspace_id ?? ""),
        () => {},
      );
  }, [templateId]);

  const search = useCallback(
    async (q: string) =>
      (await tableApi.principals(q)).map((p) => ({
        principalType: p.principal_type,
        principalId: p.principal_id,
        label: p.label,
      })),
    [],
  );

  if (shares === null) return error ? <p role="alert">{error}</p> : <LibraryShareFormSkeleton />;
  return (
    <LibraryShareForm
      shares={shares}
      workspace={{ principalType: "workspace", principalId: workspaceId, label: "Everyone" }}
      // Whole-workspace sharing is publishing, which goes through approval instead.
      canShareWorkspace={false}
      search={search}
      error={error}
      onChange={(next) => {
        setError(null);
        tableApi
          .putTemplateShares(
            templateId,
            next.map((s) => ({
              principal_type: s.principalType,
              principal_id: s.principalId,
              level: s.level,
            })),
          )
          .then(
            (saved) => {
              setShares(saved.map(toShare));
              onChanged();
            },
            (err) => setError(messageOf(err)),
          );
      }}
    />
  );
}

function RejectPanel({
  name,
  onClose,
  onReject,
}: {
  name: string;
  onClose: () => void;
  onReject: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  return (
    <SidePanel title={`Reject ${name}`} onClose={onClose} width={400}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void onReject(note.trim());
        }}
      >
        <label htmlFor="reject-note" className="text-ui font-medium">
          Tell the author why
        </label>
        <Textarea
          id="reject-note"
          rows={4}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Button type="submit">Reject template</Button>
      </form>
    </SidePanel>
  );
}
