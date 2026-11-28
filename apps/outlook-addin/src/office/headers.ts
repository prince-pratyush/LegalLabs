/**
 * The addresses a reply will go to instead of the sender, from the message's own headers: empty
 * when there is no Reply-To, null when that can't be told.
 */
export function replyToOf(headers: string): string[] | null {
  // Some messages, such as internal ones, carry no headers at all.
  if (!headers.trim()) return null;
  const lines = headers.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
  const values = lines.flatMap((line) => /^reply-to:(.*)$/i.exec(line)?.[1] ?? []);
  if (values.length === 0) return [];
  // A name or a comment may hold something that looks like the address, so both go first.
  const bare = values
    .join(",")
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/\([^()]*\)/g, " ");
  const bracketed = [...bare.matchAll(/<([^<>]*)>/g)].map((m) => m[1] ?? "");
  const rest = bare.replace(/<[^<>]*>/g, "\0").split(",");
  // Outside angle brackets, only a part with none of its own is an address.
  const plain = rest.filter((part) => !part.includes("\0"));
  const found = [...bracketed, ...plain]
    .map((part) => part.trim())
    .filter((part) => /^[^\s<>,;:"()@]+@[^\s<>,;:"()@]+$/.test(part));
  return found.length > 0 ? found : null;
}
