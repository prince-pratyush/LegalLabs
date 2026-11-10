import type { Citation } from "./api.js";

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
