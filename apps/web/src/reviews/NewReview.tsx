import { estimatePages, type Playbook, type PlaybookSummary } from "@legallabs/contracts";
import {
  CustomiseReviewForm,
  CustomiseReviewFormSkeleton,
  type ReviewSettings,
} from "@legallabs/ui";
import { useEffect, useState } from "react";
import { api, type DocumentSummary } from "../api.js";
import { playbookApi } from "../playbooks/api.js";
import { messageOf } from "../vaults/shared.js";
import { reviewApi } from "./api.js";
import { goReviews } from "./route.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * The customise sheet. A playbook's page fixes the playbook and a vault file fixes the
 * document; whatever isn't fixed is picked here.
 */
export function NewReview({
  playbookId: fixedPlaybook,
  documentId: fixedDocument,
  onCancel,
}: {
  playbookId: string | null;
  documentId: string | null;
  onCancel: () => void;
}) {
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[] | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [playbookId, setPlaybookId] = useState(fixedPlaybook);
  const [documentId, setDocumentId] = useState(fixedDocument);
  const [playbook, setPlaybook] = useState<Playbook | null>(null);
  const [document, setDocument] = useState<DocumentSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (fixedPlaybook) return;
    playbookApi.list({ status: "published" }).then(setPlaybooks, (err) => {
      setPlaybooks([]);
      setError(messageOf(err));
    });
  }, [fixedPlaybook]);

  useEffect(() => {
    if (fixedDocument) return;
    api.documents().then(
      // A Word file is read from the file itself, so it needn't wait for indexing.
      (all) => setDocuments(all.filter((d) => d.status === "indexed" || d.mime === DOCX)),
      (err) => {
        setDocuments([]);
        setError(messageOf(err));
      },
    );
  }, [fixedDocument]);

  useEffect(() => {
    setPlaybook(null);
    if (!playbookId) return;
    playbookApi.get(playbookId).then(setPlaybook, (err) => setError(messageOf(err)));
  }, [playbookId]);

  useEffect(() => {
    if (!documentId) return setDocument(null);
    const listed = documents?.find((d) => d.id === documentId);
    if (listed) return setDocument(listed);
    reviewApi.document(documentId).then(setDocument, (err) => setError(messageOf(err)));
  }, [documentId, documents]);

  const start = async (settings: ReviewSettings, options: { draft: boolean }) => {
    if (!playbookId || !document) return;
    setBusy(true);
    setError(null);
    try {
      const started = await reviewApi.start(
        playbookId,
        { ...settings, document_version_id: document.version_id, surface: "web" },
        options.draft,
      );
      goReviews({ page: "review", reviewId: started.review_id });
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  const loading = (!fixedPlaybook && playbooks === null) || (!fixedDocument && documents === null);
  return (
    <div className="grid max-w-xl gap-4">
      <header className="grid gap-1">
        <h1 className="text-title font-semibold">Review a contract</h1>
        <p className="text-fg-muted">
          {playbook ? `Against ${playbook.name}` : "Choose a playbook and a contract."}
          {fixedDocument && document ? ` · ${document.name}` : ""}
        </p>
      </header>
      {loading ? (
        <CustomiseReviewFormSkeleton />
      ) : (
        <CustomiseReviewForm
          {...(fixedPlaybook
            ? {}
            : {
                playbooks: (playbooks ?? []).map((p) => ({ id: p.id, name: p.name })),
                onPlaybookChange: setPlaybookId,
              })}
          {...(fixedDocument
            ? {}
            : {
                documents: (documents ?? []).map((d) => ({ id: d.id, name: d.name })),
                onDocumentChange: setDocumentId,
              })}
          playbookId={playbookId}
          documentId={document ? documentId : null}
          rules={playbook ? playbook.rules.map((r) => ({ id: r.id, title: r.title })) : null}
          pages={document?.page_count ? estimatePages(0, document.page_count) : null}
          canUseDraft={playbook?.access === "edit" || playbook?.access === "manage"}
          busy={busy}
          error={error}
          onSubmit={start}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}
