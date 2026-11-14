import { createDocprocParser, DocprocUnavailable } from "./docproc.js";
import { runIsolated } from "./isolate.js";
import { detectType, type IngestResult, LOCAL_TYPES } from "./process.js";

export { boxesFor } from "./boxes.js";
export type { Chunk } from "./chunk.js";
export { createDocprocParser, DocprocUnavailable } from "./docproc.js";
export type { Block, Child, Failure, Heading, Ingested, IngestResult, Page } from "./process.js";
export { DOCX, detectType, XLSX } from "./process.js";

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

export interface IngestOptions {
  /** The docproc sidecar. Without it only PDF, TXT and Markdown can be read. */
  docprocUrl?: string;
  fetch?: typeof fetch;
  /** Reads PDF, TXT and Markdown here; tests swap it for the in-thread reader. */
  local?: (bytes: Uint8Array, name: string) => Promise<IngestResult>;
}

/** Picks a parser by type. PDF falls back to pdf.js when the sidecar can't be reached. */
export function createIngest(options: IngestOptions = {}) {
  const docproc = options.docprocUrl
    ? createDocprocParser({
        url: options.docprocUrl,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })
    : null;
  const readLocally = options.local ?? ingestFile;
  return async (bytes: Uint8Array, name: string): Promise<IngestResult> => {
    const mime = detectType(bytes, name);
    if (mime === null) return { ok: false, reason: "UNSUPPORTED_TYPE" };
    const local = LOCAL_TYPES.has(mime);
    if (!docproc || mime === "text/plain" || mime === "text/markdown") {
      return local ? readLocally(bytes, name) : { ok: false, reason: "UNSUPPORTED_TYPE" };
    }
    try {
      return await docproc(bytes, name);
    } catch (err) {
      if (!(err instanceof DocprocUnavailable)) throw err;
      // Other types have no local reader, so they wait for the sidecar to come back.
      return local ? readLocally(bytes, name) : { ok: false, reason: "INTERNAL" };
    }
  };
}
