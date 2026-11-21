import type { Gateway } from "@legallabs/model-gateway";
import type pg from "pg";
import { createMemories, type Memories } from "./memory.js";
import { createPersonalisation, type Personalisation } from "./port.js";
import { createWritingStyles, type SampleReader, type WritingStyles } from "./styles.js";

export interface MemoryModule {
  memories: Memories;
  styles: WritingStyles;
  /** Handed to the thread service so answers follow memories and the chosen writing style. */
  personalisation: Personalisation;
}

export interface MemoryOptions {
  /** Derives style instructions and proposes onboarding memories; without it those answer 503. */
  gateway?: Gateway;
  /** Reads a style sample (PDF, Word or text) into pages. */
  read?: SampleReader;
  /** Lets the model flag preferences as candidates; off by default. */
  infer?: boolean;
}

export function createMemoryModule(pool: pg.Pool, options: MemoryOptions = {}): MemoryModule {
  const memories = createMemories(pool, options.gateway ? { gateway: options.gateway } : {});
  const styles = createWritingStyles(pool, {
    ...(options.gateway ? { gateway: options.gateway } : {}),
    ...(options.read ? { read: options.read } : {}),
  });
  return {
    memories,
    styles,
    personalisation: createPersonalisation(pool, memories, { infer: options.infer === true }),
  };
}
