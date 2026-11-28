/** Which add-in a pane says it is. A claim by the caller, good only for counting. */
export const paneOf = (client: string | undefined): "word" | "outlook" =>
  client === "outlook" ? "outlook" : "word";

/** Which client a signed-in call came from, for usage counts only; it grants nothing. */
export function viaOf(
  fromPane: boolean,
  userAgent: string | undefined,
  client?: string,
): "word" | "outlook" | "mobile" | undefined {
  if (fromPane) return paneOf(client);
  // Phone browsers say "Mobi"; the header is only a hint, which is all a count needs.
  return userAgent && /Mobi|iPhone|iPod/.test(userAgent) ? "mobile" : undefined;
}
