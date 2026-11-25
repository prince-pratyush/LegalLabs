import {
  parseCitedAnswer,
  type Sources,
  ungroundedSentences,
  verifyCitation,
} from "@legallabs/citations";
import { type CitationEvent, citationPath } from "@legallabs/contracts";
import type { ContextDocument } from "./context.js";

/** A document the model was shown, under the label it cites it by. */
export type ShownDocument = ContextDocument & { label: string };

const MAX_QUOTE = 2_000;

export interface CheckedCitation {
  n: number;
  at: number;
  versionId: string | null;
  page: number | null;
  quote: string | null;
  from: number | null;
  to: number | null;
  status: "ok" | "mismatch" | "unresolved";
}

export interface CheckedAnswer {
  /** The answer without its citation tags, as it is stored. */
  text: string;
  /** The same text with a [[c:N]] marker where each citation stood, for the live view. */
  marked: string;
  citations: CheckedCitation[];
  /** Sentences no verified citation supports; empty when there was nothing to cite. */
  ungrounded: (readonly [number, number])[];
}

// The live view reads [[c:N]] as a marker, so a model can't write one itself.
const visible = (text: string) => text.replaceAll("[[c:", "[ [c:");

/**
 * Checks every citation in a run's answer against the pages the run was given (THR-003). Only
 * those count, whatever the model wrote; a quote the page doesn't hold is flagged, never linked.
 * Authority and tool-result citations aren't checked here, so they come out unresolved.
 */
export async function checkAnswer(
  raw: string,
  documents: readonly ShownDocument[],
): Promise<CheckedAnswer> {
  const parsed = parseCitedAnswer(raw.replaceAll("\0", ""));
  const sources: Sources = {
    documentPage: async (versionId, page) =>
      documents.find((d) => d.versionId === versionId)?.pages.find((p) => p.page === page)?.text ??
      null,
    webPage: async () => null,
    cellCitationStatuses: async () => null,
    authorityById: async () => null,
    authoritiesByCitation: async () => [],
    authorityPassages: async () => [],
  };

  const citations: CheckedCitation[] = [];
  for (const [i, c] of parsed.citations.entries()) {
    const document = documents.find((d) => d.label === c.doc);
    const base = {
      n: i + 1,
      at: c.at,
      versionId: document?.versionId ?? null,
      page: c.page,
      quote: c.quote?.slice(0, MAX_QUOTE) ?? null,
      from: null,
      to: null,
    };
    let result: CheckedCitation = { ...base, status: "unresolved" };
    if (document && c.quote !== null && c.quote.length <= MAX_QUOTE) {
      // Small models often get the page wrong, so the other pages shown are tried after it.
      const pages = document.pages.map((p) => p.page);
      for (const page of new Set(c.page === null ? pages : [c.page, ...pages])) {
        const found = await verifyCitation(
          { kind: "document", documentVersionId: document.versionId, page, quote: c.quote },
          sources,
        );
        if (found.status === "ok" && "located" in found) {
          // The page's wording, so a near miss never shows words the page lacks.
          const { from, to, text } = found.located;
          result = { ...base, page, quote: text, from, to, status: "ok" };
          break;
        }
        if (found.status === "mismatch") result = { ...base, status: "mismatch" };
      }
    }
    citations.push(result);
  }

  let marked = "";
  let cursor = 0;
  for (const c of citations) {
    marked += `${visible(parsed.text.slice(cursor, c.at))}[[c:${c.n}]]`;
    cursor = c.at;
  }
  marked += visible(parsed.text.slice(cursor));
  return {
    text: parsed.text,
    marked,
    citations,
    ungrounded: documents.length > 0 ? ungroundedSentences(parsed.text, citations) : [],
  };
}

export function citationEvent(
  messageId: string,
  c: CheckedCitation,
  documents: readonly ShownDocument[],
): CitationEvent {
  const document = documents.find((d) => d.versionId === c.versionId);
  const located = c.status === "ok" && c.from !== null && c.to !== null;
  const span = located ? { char_from: c.from as number, char_to: c.to as number } : {};
  return {
    message_id: messageId,
    ordinal: c.n,
    kind: "document",
    verified: c.status,
    quote: c.quote ?? "",
    ...(document
      ? {
          document: {
            document_id: document.documentId,
            version_id: document.versionId,
            name: document.name,
            ...(c.page === null ? {} : { page_no: c.page }),
            ...span,
          },
        }
      : {}),
    ...(located && document && c.page !== null
      ? {
          open_url: citationPath({
            document_id: document.documentId,
            version_no: document.versionNo,
            page: c.page,
            ...span,
          }),
        }
      : {}),
  };
}
