import type { CitationTarget } from "@legallabs/contracts";
import { Button, PANEL_MIN, SidePanel, Skeleton } from "@legallabs/ui";
import { useEffect, useState } from "react";
import { api, type DocumentSummary, messageOf } from "../api.js";
import { citationContext } from "./open-citation.js";

/**
 * Stands in for the document viewer: no endpoint serves page text yet, so it
 * shows the cited quote and keeps the deep link stable for the real viewer.
 */
export function CitationViewer({
  target,
  path,
  onClose,
}: {
  target: CitationTarget;
  path: string;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(PANEL_MIN);
  const [document, setDocument] = useState<DocumentSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const context = citationContext(path);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the fetch on Retry
  useEffect(() => {
    let live = true;
    setError(null);
    setDocument(null);
    api.document(target.document_id).then(
      (found) => live && setDocument(found),
      (err) => live && setError(messageOf(err)),
    );
    return () => {
      live = false;
    };
  }, [target.document_id, attempt]);

  const name = document?.name ?? context?.documentName ?? null;

  return (
    <SidePanel title={name ?? "Document"} onClose={onClose} width={width} onWidthChange={setWidth}>
      <div className="grid gap-4" data-testid="citation-viewer">
        <p className="text-dense text-fg-muted tabular-nums">
          Page {target.page} · Version {target.version_no}
        </p>
        {error ? (
          <div role="alert" className="grid justify-items-start gap-2">
            <p className="text-ui">{error}</p>
            <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : !document && !context ? (
          <div className="grid gap-2" aria-hidden>
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : null}
        {context?.quote ? (
          <blockquote className="border-l-2 border-citation pl-3 text-prose">
            <mark className="bg-transparent text-fg underline decoration-citation decoration-2 underline-offset-4">
              {context.quote}
            </mark>
          </blockquote>
        ) : null}
        <p className="text-caption text-fg-muted">
          Viewer coming soon. This link will open the page with the quote highlighted.
        </p>
      </div>
    </SidePanel>
  );
}
