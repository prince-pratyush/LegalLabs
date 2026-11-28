/** A LegalLabs path, or an https link; anything else from the API is never opened. */
export function safeUrl(link: string, origin: string): string | null {
  // "//host" is another site, though it looks like a path.
  if (link.startsWith("//")) return null;
  try {
    if (link.startsWith("/")) return new URL(link, origin).href;
    const url = new URL(link);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
