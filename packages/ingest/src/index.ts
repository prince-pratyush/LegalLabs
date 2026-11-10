import { runIsolated } from "./isolate.js";
import type { IngestResult } from "./process.js";

export { boxesFor } from "./boxes.js";
export type { Chunk } from "./chunk.js";
export type { Block, Failure, Ingested, IngestResult, Page } from "./process.js";

const TIMEOUT_MS = 60_000;
const MAX_MEMORY_MB = 512;

/** Parses untrusted bytes in a killable worker. Never rejects: failures are in the result. */
export async function ingestFile(bytes: Uint8Array, name: string): Promise<IngestResult> {
  const run = await runIsolated<IngestResult>(
    new URL("./worker.js", import.meta.url),
    { bytes, name },
    { timeoutMs: TIMEOUT_MS, maxMemoryMb: MAX_MEMORY_MB },
  );
  if (run.ok) return run.value;
  return { ok: false, reason: run.reason === "timeout" ? "PARSE_TIMEOUT" : "INTERNAL" };
}
