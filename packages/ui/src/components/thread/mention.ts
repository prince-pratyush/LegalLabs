export type MentionKind = "document" | "vault" | "source";

export type Mentionable = { type: MentionKind; id: string; label: string };

/**
 * The text typed after an `@` that the caret is still inside, or null.
 * An `@` mid-word (an email address) doesn't open the picker.
 */
export function mentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const prev = before[at - 1];
  if (prev !== undefined && !/\s/.test(prev)) return null;
  const query = before.slice(at + 1);
  // "meet @ 5pm" is an at sign, not a mention.
  if (/^\s/.test(query)) return null;
  // Labels can hold spaces, but a line break or a long run means the mention is over.
  if (query.includes("\n") || query.length > 60) return null;
  return { query, start: at };
}

/** Items whose label contains the query, labels that start with it first. */
export function matchMentions(
  items: readonly Mentionable[],
  query: string,
  limit = 8,
): Mentionable[] {
  const q = query.trim().toLowerCase();
  const hits = items.filter((item) => item.label.toLowerCase().includes(q));
  const starts = (item: Mentionable) => (item.label.toLowerCase().startsWith(q) ? 0 : 1);
  return [...hits].sort((a, b) => starts(a) - starts(b)).slice(0, limit);
}

/** Replaces the `@query` at `start` with `@Label `, returning the new text and caret. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  label: string,
): { text: string; caret: number } {
  const token = `@${label} `;
  return { text: text.slice(0, start) + token + text.slice(caret), caret: start + token.length };
}
