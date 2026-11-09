import {
  type AuthorityCitation,
  type AuthoritySources,
  type AuthorityVerification,
  verifyAuthority,
} from "./authority.js";
import { locateQuote, type QuoteResult } from "./quote.js";

export type CitationStatus = "ok" | "mismatch" | "unresolved";

export type Citation =
  | AuthorityCitation
  | { kind: "document"; documentVersionId: string; page: number; quote: string }
  | { kind: "web"; url: string; quote: string }
  | { kind: "cell"; cellId: string };

export interface Sources extends AuthoritySources {
  documentPage(documentVersionId: string, page: number): Promise<string | null>;
  webPage(url: string): Promise<string | null>;
  cellCitationStatuses(cellId: string): Promise<readonly CitationStatus[] | null>;
}

export type Verification =
  | AuthorityVerification
  | QuoteResult
  | { status: "ok" }
  | { status: "mismatch"; reason: "cell_citation_flagged" | "cell_has_no_citations" }
  | { status: "unresolved"; reason: "page_not_found" | "url_not_fetched" | "cell_not_found" };

/** Lookup failures reject, so an outage is never reported as a bad citation. */
export async function verifyCitation(citation: Citation, sources: Sources): Promise<Verification> {
  switch (citation.kind) {
    case "authority":
      return verifyAuthority(citation, sources);
    case "document": {
      const page = await sources.documentPage(citation.documentVersionId, citation.page);
      if (page === null) return { status: "unresolved", reason: "page_not_found" };
      return locateQuote(page, citation.quote);
    }
    case "web": {
      const page = await sources.webPage(citation.url);
      if (page === null) return { status: "unresolved", reason: "url_not_fetched" };
      return locateQuote(page, citation.quote);
    }
    case "cell": {
      const statuses = await sources.cellCitationStatuses(citation.cellId);
      if (statuses === null) return { status: "unresolved", reason: "cell_not_found" };
      if (statuses.length === 0) return { status: "mismatch", reason: "cell_has_no_citations" };
      if (statuses.some((status) => status !== "ok")) {
        return { status: "mismatch", reason: "cell_citation_flagged" };
      }
      return { status: "ok" };
    }
  }
}
