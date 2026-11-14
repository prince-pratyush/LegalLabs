import { type Anchor, parseDocumentHref } from "@legallabs/contracts";
import {
  DocumentViewer,
  preloadPdf,
  StatusText,
  setPdfWorker,
  ViewerSkeleton,
} from "@legallabs/ui";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { navigate, openCitation, type ViewerState } from "./open-citation.js";
import { apiSource } from "./source.js";

let workerStarted = false;
// One worker for the whole tab, started the first time a document opens.
function startPdfWorker() {
  if (workerStarted) return;
  workerStarted = true;
  setPdfWorker(new PdfWorker());
  preloadPdf();
}

/** The viewer as a page of its own, at /documents/:id?v=&page=&span=. */
export function DocumentPage({ href, state }: { href: string; state: ViewerState | null }) {
  const location = useMemo(() => parseDocumentHref(href), [href]);
  const [versionId, setVersionId] = useState<string | null>(location?.version_id ?? null);
  const [failed, setFailed] = useState(false);
  startPdfWorker();

  // A link without a version opens the current one.
  useEffect(() => {
    setVersionId(location?.version_id ?? null);
    setFailed(false);
    if (!location || location.version_id) return;
    api.document(location.document_id).then(
      (document) => setVersionId(document.version_id),
      () => setFailed(true),
    );
  }, [location]);

  const source = useMemo(
    () => (location && versionId ? apiSource(location.document_id, versionId) : null),
    [location, versionId],
  );

  const close = () => (state ? window.history.back() : navigate("/"));
  if (!location || failed) {
    return (
      <p role="alert" className="p-6">
        <StatusText tone="failed">
          This document wasn't found, or you don't have access to it.
        </StatusText>
      </p>
    );
  }
  if (!source) return <ViewerSkeleton />;

  const anchor = state?.anchor;
  const context = state?.context ?? [];
  const index = state?.index ?? 0;
  const target = anchor
    ? anchor
    : location.page
      ? { page: location.page, char_from: location.span?.from, char_to: location.span?.to }
      : undefined;

  return (
    <div className="h-dvh">
      <DocumentViewer
        key={`${location.document_id}:${versionId}`}
        source={source}
        target={target}
        anchors={context}
        index={index}
        onStep={(next) => {
          const to = context[next] as Anchor | undefined;
          if (to) openCitation(to, { context });
        }}
        onClose={close}
        onOpenAttachment={(attachment) =>
          navigate(`/documents/${attachment.document_id}?v=${attachment.version_id}&page=1`)
        }
        origin={
          state ? (
            <button type="button" className="underline" onClick={close}>
              Back to the answer
            </button>
          ) : null
        }
      />
    </div>
  );
}

export const isDocumentHref = (href: string) => parseDocumentHref(href) !== null;
