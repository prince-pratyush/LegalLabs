import type { Block } from "./process.js";

/** The line boxes behind a verified quote's offsets, for drawing the highlight. */
export function boxesFor(blocks: readonly Block[], from: number, to: number): Block[] {
  return blocks.filter((block) => block.from < to && block.to > from);
}
