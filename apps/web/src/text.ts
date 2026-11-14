import type { Citation, DocumentSummary } from "./api.js";

export type Segment = { text: string } | { citation: Citation };

/** Splits an answer at its citation anchors, so each marker sits where its claim ends. */
export function segments(content: string, citations: readonly Citation[]): Segment[] {
  const ordered = [...citations].sort((a, b) => a.at - b.at || a.n - b.n);
  const parts: Segment[] = [];
  let from = 0;
  for (const citation of ordered) {
    // An anchor past the end still shows, so no citation silently disappears.
    const at = Math.min(Math.max(citation.at, from), content.length);
    if (at > from) parts.push({ text: content.slice(from, at) });
    parts.push({ citation });
    from = at;
  }
  if (from < content.length) parts.push({ text: content.slice(from) });
  return parts;
}

const FAILURES: Record<string, string> = {
  UNSUPPORTED_TYPE: "This type of file can't be read.",
  CORRUPT_FILE: "The file is damaged and can't be read.",
  ENCRYPTED_NO_PASSWORD: "The file is password protected.",
  PAGE_LIMIT_EXCEEDED: "The document is too long.",
  FILE_TOO_LARGE: "The file is too large.",
  NO_TEXT: "No text was found.",
  PARSE_TIMEOUT: "The file took too long to read.",
  TOO_COMPLEX: "The file needs too much memory to read.",
  FORBIDDEN: "You no longer have access to this file.",
  MALWARE_FOUND: "The file was blocked because it may be harmful.",
  SCAN_UNAVAILABLE: "The file couldn't be checked for malware. Try again later.",
};

/** What the list says about a file while, or after, it is read. */
export function documentStatus(document: DocumentSummary): string {
  if (document.status === "queued") return "Waiting to be read";
  if (document.status === "parsing") return "Reading";
  if (document.status === "failed") {
    return FAILURES[document.failure_reason ?? ""] ?? "The file couldn't be processed.";
  }
  return document.page_count === 1 ? "1 page" : `${document.page_count ?? 0} pages`;
}
