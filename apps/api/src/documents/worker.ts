import { createHash } from "node:crypto";
import {
  type Child,
  detectType,
  type Failure,
  type Ingested,
  type IngestResult,
  ingestFile,
  type Scanner,
  ScannerRefused,
  ScannerUnavailable,
} from "@legallabs/ingest";
import { contentKey, type ObjectStore } from "@legallabs/storage";
import type pg from "pg";
import { asApp, asWorker, RLS_REFUSED } from "../db.js";

export interface IngestWorkerOptions {
  store: ObjectStore;
  ingest?: (bytes: Uint8Array, name: string) => Promise<IngestResult>;
  /** Runs before any parser sees the bytes. */
  scanner: Scanner;
  /** Files read at once. Each holds its bytes in memory and a parser worker. */
  concurrency?: number;
  pollMs?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  /** Ids and reasons only: never a name or any text. */
  log?: (message: string) => void;
}

export interface IngestWorker {
  /** Reads one due file. False when nothing was due. */
  runOnce(onlyWorkspace?: string): Promise<boolean>;
  /** Reads due files until none are left. */
  drain(onlyWorkspace?: string): Promise<number>;
  /** Tests pass a workspace so parallel files don't take each other's jobs. */
  start(onlyWorkspace?: string): void;
  stop(): Promise<void>;
}

interface Claim {
  version_id: string;
  workspace_id: string;
  document_id: string;
  created_by: string;
  sha256: Buffer;
  attempt: number;
  lease: string;
}

class LostLease extends Error {}

// Names come from inside the file, so they are cleaned like a typed one would be.
const safeName = (name: string) =>
  name
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "")
    .slice(0, 255)
    .trim() || "attachment";

export type IngestReason =
  | Failure
  | "FORBIDDEN"
  | "MISSING_ORIGINAL"
  | "MALWARE_FOUND"
  | "SCAN_UNAVAILABLE";

const BATCH_SIZE = 200;
// A mailbox holds messages, a message holds attachments, and that is as deep as it goes.
const MAX_DEPTH = 2;
// Per level, so one uploaded file stays bounded: messages in a mailbox, then attachments.
const MAX_CHILDREN = [5000, 50];

// Worth another try: the same bytes may well succeed on a quieter machine.
const TRANSIENT = new Set<IngestReason>([
  "INTERNAL",
  "PARSE_TIMEOUT",
  "TOO_COMPLEX",
  "SCAN_UNAVAILABLE",
]);

function batches<T>(items: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) groups.push(items.slice(i, i + BATCH_SIZE));
  return groups;
}

async function savePages(db: pg.PoolClient, job: Claim, parsed: Ingested) {
  const ocr = new Set(parsed.ocrPages ?? []);
  for (const group of batches(parsed.pages)) {
    await db.query(
      `insert into content.page (workspace_id, version_id, page_no, width, height, text, layout, ocr)
       select $1, $2, * from unnest($3::int[], $4::real[], $5::real[], $6::text[], $7::jsonb[], $8::bool[])`,
      [
        job.workspace_id,
        job.version_id,
        group.map((page) => page.pageNo),
        group.map((page) => page.width),
        group.map((page) => page.height),
        group.map((page) => page.text),
        group.map((page) => JSON.stringify({ blocks: page.blocks })),
        group.map((page) => ocr.has(page.pageNo)),
      ],
    );
  }
  for (const group of batches(parsed.chunks)) {
    await db.query(
      `insert into content.chunk
         (workspace_id, version_id, page_no, ordinal, char_from, char_to, text, section)
       select $1, $2, * from unnest($3::int[], $4::int[], $5::int[], $6::int[], $7::text[], $8::text[])`,
      [
        job.workspace_id,
        job.version_id,
        group.map((chunk) => chunk.pageNo),
        group.map((chunk) => chunk.ordinal),
        group.map((chunk) => chunk.from),
        group.map((chunk) => chunk.to),
        group.map((chunk) => chunk.text),
        group.map((chunk) => chunk.section),
      ],
    );
  }
}

export function createIngestWorker(pool: pg.Pool, options: IngestWorkerOptions): IngestWorker {
  const ingest = options.ingest ?? ingestFile;
  const concurrency = options.concurrency ?? 2;
  const pollMs = options.pollMs ?? 1000;
  const leaseSeconds = options.leaseSeconds ?? 300;
  const maxAttempts = options.maxAttempts ?? 3;
  const log = options.log ?? (() => {});

  // The job runs as its uploader, so a lost wall or permission stops it.
  const asUploader = <T>(job: Claim, work: (db: pg.PoolClient) => Promise<T>) =>
    asApp(pool, { userId: job.created_by, workspaceId: job.workspace_id }, work);

  // False when the lease was lost: another worker owns the job, and its outcome stands.
  async function finish(
    db: pg.PoolClient,
    job: Claim,
    status: "indexed" | "failed" | "queued",
    extra: { reason?: IngestReason; retrySeconds?: number } = {},
  ): Promise<boolean> {
    const { rows } = await db.query<{ ok: boolean }>(
      "select content.finish_ingest_job($1, $2, $3, $4, $5) ok",
      [job.version_id, job.lease, status, extra.reason ?? null, extra.retrySeconds ?? null],
    );
    return rows[0]?.ok === true;
  }

  async function fail(job: Claim, reason: IngestReason) {
    if (TRANSIENT.has(reason) && job.attempt < maxAttempts) {
      // 30 s, then 2 min: long enough for a crashed dependency to come back.
      const retrySeconds = 30 * 4 ** (job.attempt - 1);
      await asUploader(job, (db) => finish(db, job, "queued", { retrySeconds }));
      log(`ingest ${job.version_id} retrying after ${reason}`);
      return;
    }
    const settled = await asUploader(job, async (db) => {
      if (!(await finish(db, job, "failed", { reason }))) return false;
      await db.query(
        "select admin.append_audit_event('document.ingest_failed', 'system', null, 'document', $1, $2)",
        [job.document_id, JSON.stringify({ version_id: job.version_id, failure_reason: reason })],
      );
      return true;
    });
    if (settled) log(`ingest ${job.version_id} failed: ${reason}`);
  }

  async function read(job: Claim): Promise<IngestReason | "indexed" | "quarantined"> {
    const source = await asUploader(job, async (db) => {
      const { rows } = await db.query<{ name: string; matter_id: string | null; depth: number }>(
        `with recursive up as (
           select id, parent_id, 0 depth from content.document where id = $1
           union all
           select d.id, d.parent_id, up.depth + 1 from content.document d
             join up on d.id = up.parent_id where up.depth < $2
         )
         select d.name, d.matter_id, (select max(depth) from up)::int depth
           from content.document d where d.id = $1 and core.has_permission('threads.use')`,
        [job.document_id, MAX_DEPTH],
      );
      return rows[0] ?? null;
    });
    if (source === null) return "FORBIDDEN";
    const { name } = source;

    const hex = job.sha256.toString("hex");
    const bytes = await options.store.get(contentKey(job.workspace_id, hex));
    // A changed object would make citations point at text the file never had.
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== hex) {
      return "MISSING_ORIGINAL";
    }
    let verdict: Awaited<ReturnType<Scanner["scan"]>>;
    try {
      verdict = await options.scanner.scan(bytes);
    } catch (err) {
      if (err instanceof ScannerUnavailable) return "SCAN_UNAVAILABLE";
      if (err instanceof ScannerRefused) return "FILE_TOO_LARGE";
      throw err;
    }
    if (!verdict.clean) {
      const settled = await asUploader(job, async (db) => {
        if (!(await finish(db, job, "failed", { reason: "MALWARE_FOUND" }))) return false;
        await db.query(
          "select admin.append_audit_event('document.quarantined', 'system', null, 'document', $1, $2)",
          [
            job.document_id,
            JSON.stringify({ version_id: job.version_id, signature: verdict.signature }),
          ],
        );
        return true;
      });
      if (settled) log(`ingest ${job.version_id} quarantined`);
      return "quarantined";
    }

    const parsed = await ingest(bytes, name);
    if (!parsed.ok) return parsed.reason;

    const children = (parsed.children ?? []).slice(0, MAX_CHILDREN[source.depth] ?? 0);
    const stored: (Child & { sha256: Buffer })[] = [];
    for (const child of children) {
      const sha256 = createHash("sha256").update(child.bytes).digest();
      await options.store.putIfAbsent(
        contentKey(job.workspace_id, sha256.toString("hex")),
        child.bytes,
      );
      stored.push({ ...child, sha256 });
    }

    await asUploader(job, async (db) => {
      await savePages(db, job, parsed);
      // One statement each: a policy can't see a row inserted earlier in the same statement.
      for (const child of stored) {
        const document = await db.query<{ id: string }>(
          `insert into content.document
             (workspace_id, owner_id, matter_id, parent_id, name, mime, size)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [
            job.workspace_id,
            job.created_by,
            source.matter_id,
            job.document_id,
            safeName(child.name),
            detectType(child.bytes, child.name) ?? "application/octet-stream",
            child.bytes.length,
          ],
        );
        const version = await db.query<{ id: string }>(
          `insert into content.document_version (workspace_id, document_id, sha256, created_by)
           values ($1, $2, $3, $4) returning id`,
          [job.workspace_id, document.rows[0]?.id, child.sha256, job.created_by],
        );
        await db.query(
          "insert into content.ingest_job (workspace_id, version_id) values ($1, $2)",
          [job.workspace_id, version.rows[0]?.id],
        );
      }
      // Thrown, not returned, so the pages just written roll back with it.
      if (!(await finish(db, job, "indexed"))) throw new LostLease();
    });
    return "indexed";
  }

  async function runOnce(onlyWorkspace?: string): Promise<boolean> {
    const job = await asWorker(pool, async (db) => {
      const { rows } = await db.query<Claim>("select * from content.claim_ingest_job($1, $2, $3)", [
        leaseSeconds,
        maxAttempts,
        onlyWorkspace ?? null,
      ]);
      return rows[0];
    });
    if (!job) return false;
    // Renewed while reading, so a slow file isn't taken by a second worker.
    const renewal = setInterval(
      () => {
        asWorker(pool, (db) =>
          db.query("select content.renew_ingest_lease($1, $2, $3)", [
            job.version_id,
            job.lease,
            leaseSeconds,
          ]),
        ).catch(() => log(`ingest ${job.version_id} lease renewal failed`));
      },
      (leaseSeconds * 1000) / 3,
    );
    try {
      const outcome = await read(job);
      if (outcome === "indexed") log(`ingest ${job.version_id} indexed`);
      else if (outcome !== "quarantined") await fail(job, outcome);
    } catch (err) {
      if (err instanceof LostLease) return true;
      const code = (err as { code?: string }).code;
      await fail(job, code === RLS_REFUSED ? "FORBIDDEN" : "INTERNAL");
    } finally {
      clearInterval(renewal);
    }
    return true;
  }

  let running = false;
  let loops: Promise<void>[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function loop(onlyWorkspace?: string) {
    while (running) {
      let worked = false;
      try {
        worked = await runOnce(onlyWorkspace);
      } catch (err) {
        log(`ingest worker error: ${err instanceof Error ? err.name : "unknown"}`);
      }
      if (!worked) await sleep(pollMs);
    }
  }

  return {
    runOnce,
    async drain(onlyWorkspace) {
      let count = 0;
      while (await runOnce(onlyWorkspace)) count++;
      return count;
    },
    start(onlyWorkspace) {
      if (running) return;
      running = true;
      loops = Array.from({ length: concurrency }, () => loop(onlyWorkspace));
    },
    async stop() {
      running = false;
      await Promise.all(loops);
      loops = [];
    },
  };
}
