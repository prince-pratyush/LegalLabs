import { runIsolated } from "./isolate.js";
import type { IngestResult } from "./process.js";

export { boxesFor } from "./boxes.js";
export type { Chunk } from "./chunk.js";
export type { Block, Failure, Ingested, IngestResult, Page } from "./process.js";

const LIMITS = { timeoutMs: 60_000, maxMemoryMb: 256, maxGrowthMb: 1024 };

const FAILURES = {
  timeout: "PARSE_TIMEOUT",
  memory: "TOO_COMPLEX",
  crashed: "INTERNAL",
} as const;

/** Parses untrusted bytes in a killable worker. Never rejects: failures are in the result. */
export async function ingestFile(bytes: Uint8Array, name: string): Promise<IngestResult> {
  const run = await runIsolated<IngestResult>(
    new URL("./worker.js", import.meta.url),
    { bytes, name },
    LIMITS,
  );
  return run.ok ? run.value : { ok: false, reason: FAILURES[run.reason] };
}
