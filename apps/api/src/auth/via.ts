/** Which client a signed-in call came from, for usage counts only; it grants nothing. */
export function viaOf(
  fromPane: boolean,
  userAgent: string | undefined,
): "word" | "mobile" | undefined {
  if (fromPane) return "word";
  // Phone browsers say "Mobi"; the header is only a hint, which is all a count needs.
  return userAgent && /Mobi|iPhone|iPod/.test(userAgent) ? "mobile" : undefined;
}
