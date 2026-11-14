import { type CitationTarget, citationPath } from "@legallabs/contracts";
import { navigate } from "../router.js";

/** What the thread already knows about a citation, so the viewer can show it at once. */
export interface CitationContext {
  documentName?: string | null;
  quote?: string | null;
}

// Keyed by deep link; a cold load of the link simply has no context.
const known = new Map<string, CitationContext>();

export const citationContext = (path: string): CitationContext | undefined => known.get(path);

/**
 * Opens a verified citation at its pinned version and page. A placeholder:
 * the document viewer replaces this with the real page and highlight.
 */
export function openCitation(target: CitationTarget, context: CitationContext = {}) {
  const path = citationPath(target);
  known.set(path, context);
  navigate(path);
}
