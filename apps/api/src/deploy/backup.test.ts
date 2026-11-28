import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@legallabs/db";
import { contentKey } from "@legallabs/storage";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  type Bucket,
  createBackup,
  exportLedger,
  openArchive,
  restoreBackup,
  sealArchive,
  verifyBackup,
} from "./backup.js";

// Real pg_dump and pg_restore against databases of the test's own; the bucket is in memory.
const server = inject("databaseUrl");
const named = (name: string) => {
  const url = new URL(server);
  url.pathname = `/${name}`;
  return url.toString();
};
const suffix = randomUUID().slice(0, 8);
const live = `ll_live_${suffix}`;
const clean = `ll_clean_${suffix}`;

function memoryBucket(): Bucket & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async *list() {
      yield* [...objects.keys()];
    },
    get: async (key) => objects.get(key) ?? null,
    put: async (key, bytes) => void objects.set(key, bytes),
    delete: async (key) => void objects.delete(key),
  };
}

async function run<T extends pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const bucket = memoryBucket();
const ids = {
  ws: "",
  user: "",
  kept: "",
  purged: "",
  binned: "",
  thread: "",
  keys: {} as Record<string, string>,
};
const quiet = () => {};

async function addDocument(url: string, name: string) {
  const bytes = new TextEncoder().encode(`${name} ${randomUUID()}`);
  const sha = createHash("sha256").update(bytes).digest();
  const [doc] = await run<{ id: string }>(
    url,
    `insert into content.document (workspace_id, owner_id, name, mime, size)
     values ($1, $2, $3, 'text/plain', $4) returning id`,
    [ids.ws, ids.user, name, bytes.length],
  );
  const id = doc?.id ?? "";
  await run(
    url,
    `insert into content.document_version (workspace_id, document_id, sha256, created_by)
     values ($1, $2, $3, $4)`,
    [ids.ws, id, sha, ids.user],
  );
  const key = contentKey(ids.ws, sha.toString("hex"));
  bucket.objects.set(key, bytes);
  ids.keys[name] = key;
  return id;
}

beforeAll(async () => {
  for (const name of [live, clean]) await run(server, `create database ${name}`);
  await migrate(named(live));
  const url = named(live);
  const [ws] = await run<{ id: string }>(
    url,
    "insert into core.workspace (slug, name, region) values ($1, $1, 'au') returning id",
    [`bk-${suffix}`],
  );
  ids.ws = ws?.id ?? "";
  const [user] = await run<{ id: string }>(
    url,
    `insert into core."user" (workspace_id, email, status) values ($1, 'a@example.test', 'active')
     returning id`,
    [ids.ws],
  );
  ids.user = user?.id ?? "";
  ids.kept = await addDocument(url, "kept");
  ids.purged = await addDocument(url, "purged");
  ids.binned = await addDocument(url, "binned");
  const [thread] = await run<{ id: string }>(
    url,
    "insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 't') returning id",
    [ids.ws, ids.user],
  );
  ids.thread = thread?.id ?? "";
  await run(
    url,
    `insert into core.session (workspace_id, user_id, token_hash, expires_at)
     values ($1, $2, $3, now() + interval '1 hour')`,
    [ids.ws, ids.user, randomBytes(32)],
  );
  await run(url, `select set_config('app.workspace_id', $1, false)`, [ids.ws]);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("select set_config('app.workspace_id', $1, false)", [ids.ws]);
  await client.query("select admin.append_audit_event('workspace.created', 'system', null)");
  await client.end();
});

afterAll(async () => {
  for (const name of [live, clean])
    await run(server, `drop database if exists ${name} with (force)`);
});

const dir = mkdtempSync(join(tmpdir(), "legallabs-backup-test-"));
const backupDir = join(dir, "backup");

describe("backup", () => {
  it("dumps the database and every object, and counts what it holds", async () => {
    const manifest = await createBackup({
      databaseUrl: named(live),
      databases: [live],
      bucket,
      dir: backupDir,
      print: quiet,
    });
    expect(manifest.counts["content.document"]).toBe(3);
    expect(manifest.objects).toHaveLength(3);
    expect(manifest.snapshot_at).toMatch(/^\d{4}-/);
  });

  it("verifies by restoring to a scratch database it then drops", async () => {
    const report = await verifyBackup({ databaseUrl: named(live), dir: backupDir, print: quiet });
    expect(report.problems).toEqual([]);
    expect(report.audit_events).toBeGreaterThan(0);
    const left = await run(server, "select 1 from pg_database where datname like 'll_verify_%'");
    expect(left).toEqual([]);
  });

  it("fails verification when a file has changed or a count is off", async () => {
    const manifestPath = join(backupDir, "manifest.json");
    const original = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(original);
    manifest.counts["content.document"] = 4;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const objectPath = join(backupDir, "objects", ids.keys.kept ?? "");
    const bytes = readFileSync(objectPath);
    writeFileSync(objectPath, "tampered");
    const report = await verifyBackup({ databaseUrl: named(live), dir: backupDir, print: quiet });
    expect(report.problems.join("\n")).toMatch(/content\.document: 3 rows, expected 4/);
    expect(report.problems.join("\n")).toContain("does not match its checksum");
    writeFileSync(manifestPath, original);
    writeFileSync(objectPath, bytes);
  });

  it("travels as one encrypted file that only the passphrase opens", async () => {
    const file = join(dir, "backup.tar.gpg");
    await sealArchive(backupDir, file, "a passphrase long enough");
    expect(readFileSync(file).includes(Buffer.from("manifest.json"))).toBe(false);
    await expect(openArchive(file, join(dir, "wrong"), "not it")).rejects.toThrow();
    await openArchive(file, join(dir, "opened"), "a passphrase long enough");
    expect(readFileSync(join(dir, "opened", "manifest.json"), "utf8")).toBe(
      readFileSync(join(backupDir, "manifest.json"), "utf8"),
    );
  });
});

describe("restore replays later deletions (SEC-030)", () => {
  let ledger: Awaited<ReturnType<typeof exportLedger>>;

  beforeAll(async () => {
    // After the backup point: one file purged, one binned, one thread purged.
    await run(named(live), "delete from content.document where id = $1", [ids.purged]);
    bucket.objects.delete(ids.keys.purged ?? "");
    await run(
      named(live),
      `update content.document set deleted_at = now(), deleted_by = owner_id,
         deleted_reason = 'user' where id = $1`,
      [ids.binned],
    );
    await run(named(live), "delete from work.thread where id = $1", [ids.thread]);
    ledger = await exportLedger(named(live));
  });

  it("refuses without a record of what was deleted since", async () => {
    await expect(
      restoreBackup({
        databaseUrl: named(clean),
        database: clean,
        bucket: memoryBucket(),
        dir: backupDir,
        print: quiet,
      }),
    ).rejects.toThrow(/no record of later deletions/);
  });

  it("brings the data back into a clean database, without what was deleted", async () => {
    const restored = memoryBucket();
    const report = await restoreBackup({
      databaseUrl: named(clean),
      database: clean,
      bucket: restored,
      dir: backupDir,
      ledger,
      print: quiet,
    });
    const documents = await run<{ id: string; deleted: boolean }>(
      named(clean),
      "select id, deleted_at is not null as deleted from content.document",
    );
    expect(documents).toHaveLength(2);
    expect(documents.find((d) => d.id === ids.kept)?.deleted).toBe(false);
    expect(documents.find((d) => d.id === ids.binned)?.deleted).toBe(true);
    expect(await run(named(clean), "select 1 from work.thread")).toEqual([]);
    expect([...restored.objects.keys()].sort()).toEqual([ids.keys.kept, ids.keys.binned].sort());
    expect(report.replayed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ object_id: ids.purged, action: "purged" }),
        expect.objectContaining({ object_id: ids.binned, action: "binned" }),
        expect.objectContaining({ object_id: ids.thread, action: "purged" }),
      ]),
    );
    expect(report.replayed).toHaveLength(3);
  });

  it("signs everyone out and records the restore in the audit trail", async () => {
    expect(await run(named(clean), "select 1 from core.session where revoked_at is null")).toEqual(
      [],
    );
    const events = await run<{ action: string; details: { replayed_deletions: number } }>(
      named(clean),
      "select action, details from admin.audit_event where action = 'restore.completed'",
    );
    expect(events[0]?.details.replayed_deletions).toBe(3);
  });

  it("reads the record from the database it replaces, when that one still answers", async () => {
    const report = await restoreBackup({
      databaseUrl: named(live),
      database: live,
      bucket,
      dir: backupDir,
      print: quiet,
    });
    expect(report.replayed).toHaveLength(3);
    expect(await run(named(live), "select 1 from content.document")).toHaveLength(2);
    // The record survives, so a second restore from the same backup deletes them again.
    expect((await exportLedger(named(live)))?.entries.length).toBeGreaterThanOrEqual(3);
  });
});
