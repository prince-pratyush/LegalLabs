import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { migrate, readAuditChain, verifyAuditChain } from "@legallabs/db";
import { contentKey } from "@legallabs/storage";
import pg from "pg";

// Backup, verify and restore of the database and the object store (06-security 5.9). Everything
// here runs as the database owner, never from the serving process.

export interface Bucket {
  list(): AsyncIterable<string>;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Manifest {
  format: 1;
  /** The database clock when the app's snapshot was taken: the backup point. */
  snapshot_at: string;
  /** The app's database first, then any others dumped beside it. */
  databases: { name: string; owner: string; file: string }[];
  workspaces: string[];
  counts: Record<string, number>;
  objects: { key: string; sha256: string; size: number }[];
}

export type ObjectType = "thread" | "review_table" | "document" | "folder" | "vault";

export interface LedgerEntry {
  id: string;
  workspace_id: string;
  object_type: ObjectType;
  object_id: string;
  action: "binned" | "restored" | "purged";
  deleted_by: string | null;
  deleted_reason: string | null;
  at: string;
}

export interface Ledger {
  exported_at: string;
  entries: LedgerEntry[];
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const quote = (name: string) => pg.escapeIdentifier(name);

function urlFor(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

const databaseOf = (databaseUrl: string) =>
  decodeURIComponent(new URL(databaseUrl).pathname.slice(1));

async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function pgTool(tool: string, databaseUrl: string, args: string[]): Promise<void> {
  const url = new URL(databaseUrl);
  const bin = process.env.PG_BIN ? join(process.env.PG_BIN, tool) : tool;
  // The password goes by environment, where other processes can't list it.
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    ...(url.password ? { PGPASSWORD: decodeURIComponent(url.password) } : {}),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (d) => {
      errors = (errors + String(d)).slice(-2000);
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${tool} failed (${code}): ${errors.trim()}`)),
    );
  });
}

/** A key that stays inside the backup's own folder when used as a file name. */
function objectPath(dir: string, key: string): string {
  if (key.startsWith("/") || key.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`refusing an object key that is not a plain path: ${key}`);
  }
  return join(dir, "objects", key);
}

async function tableCounts(client: pg.Client): Promise<Record<string, number>> {
  const { rows } = await client.query<{ schema: string; name: string }>(
    `select n.nspname as schema, c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and not c.relispartition
        and n.nspname not in ('information_schema', 'public', 'drizzle')
        and n.nspname not like 'pg\\_%'
      order by 1, 2`,
  );
  const counts: Record<string, number> = {};
  for (const t of rows) {
    const found = await client.query<{ n: string }>(
      `select count(*) as n from ${quote(t.schema)}.${quote(t.name)}`,
    );
    counts[`${t.schema}.${t.name}`] = Number(found.rows[0]?.n);
  }
  return counts;
}

export async function createBackup(options: {
  databaseUrl: string;
  /** Every database to dump; the app's own first. */
  databases: string[];
  bucket: Bucket;
  dir: string;
  print(line: string): void;
}): Promise<Manifest> {
  const { databaseUrl, bucket, dir, print } = options;
  mkdirSync(join(dir, "objects"), { recursive: true, mode: 0o700 });
  const [app, ...others] = options.databases;
  if (!app) throw new Error("no database to back up");

  const owners = await withClient(databaseUrl, async (client) => {
    const { rows } = await client.query<{ name: string; owner: string }>(
      `select datname as name, pg_get_userbyid(datdba) as owner from pg_database
        where datname = any ($1)`,
      [options.databases],
    );
    return new Map(rows.map((r) => [r.name, r.owner]));
  });
  const databases = [app, ...others.filter((name) => owners.has(name))].map((name, i) => ({
    name,
    owner: owners.get(name) ?? "postgres",
    file: i === 0 ? "app.dump" : `${name}.dump`,
  }));

  // The counts and the dump read one snapshot, so a busy server can't make them disagree.
  const point = await withClient(urlFor(databaseUrl, app), async (client) => {
    await client.query("begin isolation level repeatable read read only");
    const { rows } = await client.query<{ snapshot: string; at: string }>(
      `select pg_export_snapshot() as snapshot,
              to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`,
    );
    const { snapshot = "", at = "" } = rows[0] ?? {};
    const counts = await tableCounts(client);
    const workspaces = await client.query<{ id: string }>("select id from core.workspace");
    await pgTool("pg_dump", databaseUrl, [
      "--format=custom",
      `--snapshot=${snapshot}`,
      `--file=${join(dir, "app.dump")}`,
      `--dbname=${app}`,
    ]);
    await client.query("commit");
    return { at, counts, workspaces: workspaces.rows.map((r) => r.id) };
  });
  print(`ok: database ${app} dumped`);
  for (const db of databases.slice(1)) {
    await pgTool("pg_dump", databaseUrl, [
      "--format=custom",
      `--file=${join(dir, db.file)}`,
      `--dbname=${db.name}`,
    ]);
    print(`ok: database ${db.name} dumped`);
  }

  // After the dump: a file added meanwhile is a harmless extra.
  const objects: Manifest["objects"] = [];
  for await (const key of bucket.list()) {
    const bytes = await bucket.get(key);
    if (!bytes) continue;
    const path = objectPath(dir, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    objects.push({ key, sha256: sha256(bytes), size: bytes.length });
  }
  print(`ok: ${objects.length} stored files copied`);

  const manifest: Manifest = {
    format: 1,
    snapshot_at: point.at,
    databases,
    workspaces: point.workspaces,
    counts: point.counts,
    objects,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function readManifest(dir: string): Manifest {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  if (manifest.format !== 1) throw new Error("this backup was written in a format not known here");
  return manifest;
}

function objectProblems(dir: string, manifest: Manifest): string[] {
  return manifest.objects.flatMap((object) => {
    try {
      return sha256(readFileSync(objectPath(dir, object.key))) === object.sha256
        ? []
        : [`file ${object.key} does not match its checksum`];
    } catch {
      return [`file ${object.key} is missing from the backup`];
    }
  });
}

export interface VerifyReport {
  problems: string[];
  rows: number;
  files: number;
  audit_events: number;
}

/** Restores into a scratch database, then checks row counts, files and the audit hash chains. */
export async function verifyBackup(options: {
  /** Any database on a server that has the app's roles; the scratch one is made beside it. */
  databaseUrl: string;
  dir: string;
  print(line: string): void;
}): Promise<VerifyReport> {
  const { databaseUrl, dir, print } = options;
  const manifest = readManifest(dir);
  const problems = objectProblems(dir, manifest);
  const scratch = `ll_verify_${randomBytes(6).toString("hex")}`;
  const admin = urlFor(databaseUrl, "postgres");
  await withClient(admin, (c) => c.query(`create database ${quote(scratch)}`));
  let events = 0;
  try {
    await pgTool("pg_restore", databaseUrl, [
      "--exit-on-error",
      `--dbname=${scratch}`,
      join(dir, "app.dump"),
    ]);
    print("ok: dump restored into a scratch database");
    await withClient(urlFor(databaseUrl, scratch), async (client) => {
      const counts = await tableCounts(client);
      for (const [table, expected] of Object.entries(manifest.counts)) {
        if (counts[table] !== expected) {
          problems.push(`${table}: ${counts[table] ?? "no"} rows, expected ${expected}`);
        }
      }
      const chains = await client.query<{ id: string }>(
        "select distinct workspace_id as id from admin.audit_event",
      );
      for (const { id } of chains.rows) {
        const result = verifyAuditChain(await readAuditChain(client, id));
        if (result.ok) events += result.events;
        else problems.push(`audit chain of ${id} breaks at event ${result.seq}: ${result.reason}`);
      }
      const held = new Set(manifest.objects.map((o) => o.key));
      const versions = await client.query<{ workspace_id: string; sha: string }>(
        `select v.workspace_id, encode(v.sha256, 'hex') as sha from content.document_version v
          where not exists (select 1 from content.document_blob b
                             where b.workspace_id = v.workspace_id and b.version_id = v.id)`,
      );
      for (const v of versions.rows) {
        const key = contentKey(v.workspace_id, v.sha);
        if (!held.has(key)) problems.push(`file ${key} is named by a document but not backed up`);
      }
    });
  } finally {
    await withClient(admin, (c) => c.query(`drop database ${quote(scratch)} with (force)`));
  }
  return {
    problems,
    rows: Object.values(manifest.counts).reduce((a, b) => a + b, 0),
    files: manifest.objects.length,
    audit_events: events,
  };
}

const AT = `to_char(at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The record of deletions in a live database; null when it has none to give. */
export async function exportLedger(databaseUrl: string): Promise<Ledger | null> {
  try {
    return await withClient(databaseUrl, async (client) => {
      const found = await client.query<{ t: string | null }>(
        "select to_regclass('retention.deletion_ledger')::text as t",
      );
      if (!found.rows[0]?.t) return null;
      const { rows } = await client.query<LedgerEntry>(
        `select id, workspace_id, object_type, object_id, action, deleted_by, deleted_reason,
                ${AT} as at
           from retention.deletion_ledger order by at, id`,
      );
      return { exported_at: new Date().toISOString(), entries: rows };
    });
  } catch (err) {
    // 3D000: there is no such database.
    if ((err as { code?: string }).code === "3D000") return null;
    throw err;
  }
}

// Whether the database being replaced is this install, and so knows what it deleted since.
async function ownRecord(databaseUrl: string, manifest: Manifest): Promise<Ledger | null> {
  const ledger = await exportLedger(databaseUrl);
  if (!ledger) return null;
  const same = await withClient(databaseUrl, (client) =>
    client.query("select 1 from core.workspace where id = any ($1::uuid[]) limit 1", [
      manifest.workspaces,
    ]),
  );
  return same.rowCount ? ledger : null;
}

// What happened last to each object since the backup point.
function toReplay(ledgers: Ledger[], since: string): LedgerEntry[] {
  const last = new Map<string, LedgerEntry>();
  const all = ledgers.flatMap((l) => l.entries);
  for (const entry of all.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
    last.set(`${entry.object_type}:${entry.object_id}`, entry);
  }
  // An hour's margin: a deletion still in flight at the snapshot was stamped before it.
  // Replaying one the backup already holds changes nothing.
  const cutoff = new Date(Date.parse(since) - 60 * 60_000).toISOString();
  return [...last.values()].filter((e) => e.action !== "restored" && e.at > cutoff);
}

const TABLES: Record<ObjectType, string> = {
  thread: "work.thread",
  review_table: "work.review_table",
  document: "content.document",
  folder: "content.folder",
  vault: "content.vault",
};
// Children before what holds them, so each deletion is seen and reported.
const ORDER: ObjectType[] = ["thread", "review_table", "document", "folder", "vault"];

async function purge(client: pg.Client, entry: LedgerEntry, orphans: Set<string>) {
  const { object_type: type, object_id: id, workspace_id: ws } = entry;
  if (type === "document" || type === "vault") {
    const column = type === "document" ? "d.id" : "d.vault_id";
    const files = await client.query<{ sha: string }>(
      `select encode(v.sha256, 'hex') as sha from content.document_version v
         join content.document d on d.id = v.document_id
        where d.workspace_id = $1 and ${column} = $2`,
      [ws, id],
    );
    for (const f of files.rows) orphans.add(`${ws}/${f.sha}`);
    await client.query(
      `update work.rt_column set context_document_id = null
        where workspace_id = $1 and context_document_id in
              (select d.id from content.document d where d.workspace_id = $1 and ${column} = $2)`,
      [ws, id],
    );
  }
  if (type === "vault") {
    await client.query("delete from content.document where workspace_id = $1 and vault_id = $2", [
      ws,
      id,
    ]);
    await client.query("delete from content.folder where workspace_id = $1 and vault_id = $2", [
      ws,
      id,
    ]);
  }
  if (type === "thread" || type === "review_table" || type === "vault") {
    await client.query(
      "delete from core.share_grant where workspace_id = $1 and object_type = $2 and object_id = $3",
      [ws, type, id],
    );
  }
  const gone = await client.query(
    `delete from ${TABLES[type]} where workspace_id = $1 and id = $2`,
    [ws, id],
  );
  await client.query(
    `update retention.recycle_bin set purged_at = $3
      where workspace_id = $1 and object_id = $2 and purged_at is null and restored_at is null`,
    [ws, id, entry.at],
  );
  return (gone.rowCount ?? 0) > 0;
}

async function bin(client: pg.Client, entry: LedgerEntry) {
  const { object_type: type, object_id: id, workspace_id: ws, at } = entry;
  // Triggers are off for this one change: guards written for people (a synced vault is
  // read-only, say) must not keep a deleted item visible.
  await client.query("set local session_replication_role = replica");
  // Vaults, folders and documents also say who binned them, and documents why.
  const extra =
    type === "vault" || type === "folder"
      ? ", deleted_by = $4"
      : type === "document"
        ? ", deleted_by = coalesce($4, owner_id), deleted_reason = coalesce($5, 'user')"
        : "";
  const params: unknown[] = [ws, id, at];
  if (type === "vault" || type === "folder") params.push(entry.deleted_by);
  if (type === "document") params.push(entry.deleted_by, entry.deleted_reason);
  const binned = await client.query(
    `update ${TABLES[type]} set deleted_at = $3${extra}
      where workspace_id = $1 and id = $2 and deleted_at is null`,
    params,
  );
  await client.query("set local session_replication_role = origin");
  // Threads and tables are only restored or emptied through a recycle bin row.
  if (binned.rowCount && (type === "thread" || type === "review_table")) {
    await client.query(
      `insert into retention.recycle_bin
         (workspace_id, object_type, object_id, label, deleted_at, restorable_until)
       values ($1, $2, $3, 'Deleted before a restore', $4, $4::timestamptz + interval '30 days')
       on conflict do nothing`,
      [ws, type, id, at],
    );
  }
  return (binned.rowCount ?? 0) > 0;
}

export interface RestoreReport {
  backup_point: string;
  /** How far the record of later deletions reaches; null when there was none. */
  deletions_known_to: string | null;
  replayed: { object_type: ObjectType; object_id: string; action: "binned" | "purged" }[];
  files: number;
}

/**
 * Replaces the database and refills the object store from a backup, then deletes again whatever
 * was deleted after the backup point (SEC-030). Nothing may be serving while it runs.
 */
export async function restoreBackup(options: {
  /** The app's database, as its owner. It is dropped and made again. */
  databaseUrl: string;
  database?: string;
  bucket: Bucket;
  dir: string;
  /** Exported from the install that was lost, when it can't be read any more. */
  ledger?: Ledger | null;
  /** Restore even though what was deleted since is unknown. */
  acceptUnreplayed?: boolean;
  print(line: string): void;
}): Promise<RestoreReport> {
  const { databaseUrl, bucket, dir, print } = options;
  const target = options.database ?? databaseOf(databaseUrl);
  const manifest = readManifest(dir);
  const broken = objectProblems(dir, manifest);
  if (broken.length) throw new Error(`the backup is damaged:\n${broken.join("\n")}`);

  const own = await ownRecord(databaseUrl, manifest);
  const ledgers = [options.ledger, own].filter((l): l is Ledger => Boolean(l));
  if (ledgers.length === 0 && !options.acceptUnreplayed) {
    throw new Error(
      "refusing to restore: there is no record of later deletions, so deleted items would come " +
        "back. Give the exported record, or accept that explicitly.",
    );
  }

  const admin = urlFor(databaseUrl, "postgres");
  await withClient(admin, async (client) => {
    const serving = await client.query(
      "select 1 from pg_stat_activity where datname = $1 and usename = 'legallabs_api' limit 1",
      [target],
    );
    if (serving.rowCount) throw new Error("the API or worker is still connected; stop them first");
  });
  for (const [i, db] of manifest.databases.entries()) {
    const name = i === 0 ? target : db.name;
    await withClient(admin, async (client) => {
      await client.query(`drop database if exists ${quote(name)} with (force)`);
      await client.query(`create database ${quote(name)} owner ${quote(db.owner)}`);
    });
    await pgTool("pg_restore", databaseUrl, [
      "--exit-on-error",
      `--dbname=${name}`,
      join(dir, db.file),
    ]);
    print(`ok: database ${name} restored`);
  }
  // A newer release than the backup's brings the schema forward before anything reads it.
  await migrate(databaseUrl);

  for (const object of manifest.objects) {
    await bucket.put(object.key, readFileSync(objectPath(dir, object.key)));
  }
  print(`ok: ${manifest.objects.length} stored files put back`);

  const replayed: RestoreReport["replayed"] = [];
  const orphans = new Set<string>();
  const entries = toReplay(ledgers, manifest.snapshot_at);
  await withClient(databaseUrl, async (client) => {
    await client.query("begin");
    const perWorkspace = new Map<string, number>();
    for (const type of ORDER) {
      for (const entry of entries.filter((e) => e.object_type === type)) {
        const action = entry.action === "purged" ? "purged" : "binned";
        const changed =
          action === "purged" ? await purge(client, entry, orphans) : await bin(client, entry);
        if (!changed) continue;
        replayed.push({ object_type: type, object_id: entry.object_id, action });
        perWorkspace.set(entry.workspace_id, (perWorkspace.get(entry.workspace_id) ?? 0) + 1);
      }
    }
    // The record carries over, so a second restore from an old backup deletes them again.
    for (const e of ledgers.flatMap((l) => l.entries)) {
      await client.query(
        `insert into retention.deletion_ledger
           (id, workspace_id, object_type, object_id, action, deleted_by, deleted_reason, at)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (id) do nothing`,
        [
          e.id,
          e.workspace_id,
          e.object_type,
          e.object_id,
          e.action,
          e.deleted_by,
          e.deleted_reason,
          e.at,
        ],
      );
    }
    // A sign-in ended after the backup point must not come back with it.
    await client.query("update core.session set revoked_at = now() where revoked_at is null");
    const workspaces = await client.query<{ id: string }>("select id from core.workspace");
    for (const { id } of workspaces.rows) {
      await client.query("select set_config('app.workspace_id', $1, true)", [id]);
      await client.query(
        "select admin.append_audit_event('restore.completed', 'system', null, null, null, $1)",
        [
          JSON.stringify({
            backup_point: manifest.snapshot_at,
            replayed_deletions: perWorkspace.get(id) ?? 0,
          }),
        ],
      );
    }
    await client.query("commit");

    for (const orphan of orphans) {
      const [ws = "", sha = ""] = orphan.split("/");
      const used = await client.query(
        `select 1 from content.document_version
          where workspace_id = $1 and sha256 = decode($2, 'hex') limit 1`,
        [ws, sha],
      );
      if (!used.rowCount) await bucket.delete(contentKey(ws, sha));
    }
  });
  print(`ok: ${replayed.length} later deletions applied again`);

  return {
    backup_point: manifest.snapshot_at,
    deletions_known_to:
      ledgers
        .map((l) => l.exported_at)
        .sort()
        .at(-1) ?? null,
    replayed,
    files: manifest.objects.length,
  };
}

// gpg reads the passphrase from its own pipe (fd 3), never from the command line.
function gpg(args: string[], passphrase: string, home: string, io: "pipe-in" | "pipe-out") {
  const child = spawn(
    "gpg",
    [
      "--homedir",
      home,
      "--batch",
      "--quiet",
      "--yes",
      "--no-symkey-cache",
      "--pinentry-mode",
      "loopback",
      "--passphrase-fd",
      "3",
      ...args,
    ],
    {
      stdio: [
        io === "pipe-in" ? "pipe" : "ignore",
        io === "pipe-out" ? "pipe" : "ignore",
        "ignore",
        "pipe",
      ],
    },
  );
  const secret = child.stdio[3] as NodeJS.WritableStream;
  secret.on("error", () => {});
  secret.end(`${passphrase}\n`);
  return child;
}

const finished = (child: ReturnType<typeof spawn>, what: string) =>
  new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${what} failed (${code})`)),
    );
  });

async function withGpgHome<T>(work: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "llgpg-"));
  try {
    return await work(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Packs a backup folder into one encrypted, integrity-protected file. */
export async function sealArchive(dir: string, file: string, passphrase: string): Promise<void> {
  await withGpgHome(async (home) => {
    const encrypt = gpg(
      ["--symmetric", "--cipher-algo", "AES256", "--output", file],
      passphrase,
      home,
      "pipe-in",
    );
    const tar = spawn("tar", ["-C", dir, "-cf", "-", "."], { stdio: ["ignore", "pipe", "ignore"] });
    encrypt.stdin?.on("error", () => {});
    (tar.stdout as Readable).pipe(encrypt.stdin as NodeJS.WritableStream);
    await Promise.all([finished(tar, "tar"), finished(encrypt, "encryption")]);
  });
}

export async function openArchive(file: string, dir: string, passphrase: string): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  await withGpgHome(async (home) => {
    const decrypt = gpg(["--decrypt", file], passphrase, home, "pipe-out");
    const tar = spawn("tar", ["-C", dir, "-xf", "-"], { stdio: ["pipe", "ignore", "ignore"] });
    tar.stdin?.on("error", () => {});
    (decrypt.stdout as Readable).pipe(tar.stdin as NodeJS.WritableStream);
    const [opened, unpacked] = await Promise.allSettled([
      finished(decrypt, "decryption (wrong passphrase or damaged file)"),
      finished(tar, "tar"),
    ]);
    // A failed decryption is the reason worth reporting; tar fails because of it.
    for (const outcome of [opened, unpacked]) {
      if (outcome.status === "rejected") throw outcome.reason;
    }
  });
}
