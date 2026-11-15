import { paraHash } from "@legallabs/contracts";

// Shared with the server, so both hash a paragraph byte for byte alike.
export { paraHash };

/** Where a suggestion was found when it was made: spec'd in WRD-003 §4.5. */
export type Anchor = { paragraph_index: number; para_hash: string };

// Enough to absorb a few paragraphs added or removed above since the review.
const WINDOW = 5;

export type Located =
  | { kind: "paragraph"; index: number }
  /** Not found by position: the caller searches the body and needs exactly one hit. */
  | { kind: "search" };

/**
 * The paragraph a suggestion belongs to now. A matching hash nearby wins, nearest
 * first, so paragraphs added above the clause don't break it.
 */
export async function locate(
  paragraphs: readonly string[],
  anchor: Anchor,
  before: string,
): Promise<Located> {
  const holds = (i: number) => before === "" || (paragraphs[i] ?? "").includes(before);
  const order = [0];
  for (let d = 1; d <= WINDOW; d++) order.push(-d, d);
  for (const d of order) {
    const i = anchor.paragraph_index + d;
    const text = paragraphs[i];
    if (text === undefined) continue;
    if ((await paraHash(text)) === anchor.para_hash && holds(i))
      return { kind: "paragraph", index: i };
  }
  return { kind: "search" };
}
