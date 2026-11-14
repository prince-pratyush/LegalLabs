import type { ContentBlock } from "@legallabs/contracts";
import type { Mentionable } from "@legallabs/ui";
import type { Citation } from "../api.js";
import type { LiveCitation } from "./run-state.js";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Turns the typed question into content blocks, so each `@Label` the user
 * picked travels as a mention the server can scope to. A mention whose text
 * was edited away is dropped; plain questions stay a plain string.
 */
export function toBlocks(text: string, mentions: readonly Mentionable[]): string | ContentBlock[] {
  const byLabel = new Map(mentions.map((m) => [m.label, m]));
  if (byLabel.size === 0) return text;
  // Longest first, so "@Lease 2" isn't read as "@Lease".
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp(`@(${labels.join("|")})`, "g");
  const blocks: ContentBlock[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const item = byLabel.get(match[1] ?? "");
    if (!item) continue;
    if (match.index > last) blocks.push({ type: "text", text: text.slice(last, match.index) });
    blocks.push({ type: "mention", ref_type: item.type, ref_id: item.id, label: item.label });
    last = match.index + match[0].length;
  }
  if (!blocks.some((b) => b.type === "mention")) return text;
  if (last < text.length) blocks.push({ type: "text", text: text.slice(last) });
  return blocks;
}

/** A saved citation in the shape the answer and sources components take. */
export const toAnswerCitation = (citation: Citation): LiveCitation => ({
  n: citation.n,
  at: citation.at,
  status: citation.status,
  documentName: citation.document_name ?? citation.authority?.title ?? null,
  page: citation.page,
  quote: citation.quote,
  openUrl: citation.status === "ok" ? citation.open_url : null,
});
