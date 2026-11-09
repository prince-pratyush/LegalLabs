import { type Located, locateQuote } from "./quote.js";

export type Citation = {
  kind: "document";
  documentVersionId: string;
  page: number;
  quote: string;
};

export interface Sources {
  documentPage(documentVersionId: string, page: number): Promise<string | null>;
}

export type Verification =
  | { status: "ok"; located: Located }
  | { status: "mismatch"; reason: "quote_not_found" }
  | { status: "unresolved"; reason: "page_not_found" };

/** Lookup failures reject, so an outage is never reported as a bad citation. */
export async function verifyCitation(citation: Citation, sources: Sources): Promise<Verification> {
  const page = await sources.documentPage(citation.documentVersionId, citation.page);
  if (page === null) return { status: "unresolved", reason: "page_not_found" };
  const result = locateQuote(page, citation.quote);
  if (!result.found) return { status: "mismatch", reason: "quote_not_found" };
  return { status: "ok", located: result.located };
}
