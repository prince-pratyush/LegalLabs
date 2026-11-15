import { type Anchor, type DocumentLocation, parseDocumentHref } from "@legallabs/contracts";
import { Button, DocumentViewer, preloadPdf, StatusText, setPdfWorker } from "@legallabs/ui";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";
import { useMemo } from "react";
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

// A version id, or a version number from a /d/ link; the API takes either.
const versionKey = (l: DocumentLocation | null) =>
  l?.version_id ?? (l?.version_no ? String(l.version_no) : null);

/** The viewer as a page of its own, at /documents/:id?v=&page=&span= or /d/:id/v/:n. */
export function DocumentPage({ href, state }: { href: string; state: ViewerState | null }) {
  const location = useMemo(() => parseDocumentHref(href), [href]);
  const version = versionKey(location);
  startPdfWorker();

  const source = useMemo(
    () => (location && version ? apiSource(location.document_id, version) : null),
    [location, version],
  );

  const close = () => (state ? window.history.back() : navigate("/"));
  // A link must pin its version, so a newer upload can never change what it shows.
  if (!location || !source) {
    return (
      <p role="alert" className="p-6">
        <StatusText tone="failed">
          {location
            ? "This link doesn't say which version to open."
            : "This document wasn't found, or you don't have access to it."}
        </StatusText>
      </p>
    );
  }

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
        key={`${location.document_id}:${version}`}
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
            <Button variant="quiet" size="sm" onClick={close}>
              Back to the answer
            </Button>
          ) : null
        }
      />
    </div>
  );
}

export const isDocumentHref = (href: string) => parseDocumentHref(href) !== null;
