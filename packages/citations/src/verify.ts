import { locateQuote, type QuoteResult } from "./quote.js";

export type Citation = {
  kind: "document";
  documentVersionId: string;
  page: number;
  quote: string;
};

export interface Sources {
  documentPage(documentVersionId: string, page: number): Promise<string | null>;
}

export type Verification = QuoteResult | { status: "unresolved"; reason: "page_not_found" };

/** Lookup failures reject, so an outage is never reported as a bad citation. */
export async function verifyCitation(citation: Citation, sources: Sources): Promise<Verification> {
  const page = await sources.documentPage(citation.documentVersionId, citation.page);
  if (page === null) return { status: "unresolved", reason: "page_not_found" };
  return locateQuote(page, citation.quote);
}
