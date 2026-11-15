import { Anchor, citationHref, type OpenCitation } from "@legallabs/contracts";
import { useEffect, useLayoutEffect, useState } from "react";

/** Kept in history, so back and forward restore the citation list without a refetch. */
export interface ViewerState {
  anchor: Anchor;
  context: readonly Anchor[];
  /** Where `anchor` sits in `context`; history copies objects, so identity can't say. */
  index: number;
}

const NAVIGATE = "legallabs:navigate";

export function navigate(href: string, state: ViewerState | null = null) {
  window.history.pushState(state, "", href);
  window.dispatchEvent(new Event(NAVIGATE));
}

interface CitationFields {
  document_id: string | null;
  version_id: string | null;
  page: number | null;
  char_from: number | null;
  char_to: number | null;
  quote: string | null;
  status: Anchor["status"];
}

/** A thread citation as an anchor. Null when it names no page to open, as unresolved ones don't. */
export function anchorOf(citation: CitationFields): Anchor | null {
  if (citation.status === "unresolved") return null;
  const parsed = Anchor.safeParse({
    document_id: citation.document_id,
    version_id: citation.version_id,
    page: citation.page,
    char_from: citation.char_from,
    char_to: citation.char_to,
    quote: citation.quote,
    status: citation.status,
  });
  return parsed.success ? parsed.data : null;
}

// What had focus when the viewer opened, so closing can hand focus back to it.
let opener: HTMLElement | null = null;

/** Puts focus back on whatever opened the viewer once it closes. */
export function useReturnFocus(open: boolean) {
  useLayoutEffect(() => {
    if (open || !opener) return;
    if (opener.isConnected) opener.focus();
    opener = null;
  }, [open]);
}

/** What a citation popover calls. The URL holds the location; the quote stays in memory. */
export const openCitation: OpenCitation = (anchor, options = {}) => {
  const href = citationHref(anchor);
  if (options.newTab) {
    window.open(href, "_blank", "noopener");
    return;
  }
  if (document.activeElement instanceof HTMLElement) opener = document.activeElement;
  const context = options.context ?? [anchor];
  const index = context.findIndex((a) => citationHref(a) === href && a.quote === anchor.quote);
  navigate(href, { anchor, context, index: Math.max(0, index) });
};

const read = () => ({
  href: `${window.location.pathname}${window.location.search}`,
  state: (window.history.state ?? null) as ViewerState | null,
});

/** The current path and history state, updated on back, forward and navigate(). */
export function useLocation() {
  const [location, setLocation] = useState(read);
  useEffect(() => {
    const update = () => setLocation(read());
    window.addEventListener("popstate", update);
    window.addEventListener(NAVIGATE, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(NAVIGATE, update);
    };
  }, []);
  return location;
}
