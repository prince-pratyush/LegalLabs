import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as apply } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { readAuditChain, verifyAuditChain } from "../src/audit.js";
import { migrate, migrationsFolder } from "../src/migrate.js";

// An install that has been in use for a while, then upgraded. The older point is a real one:
// everything up to and including vault and thread work, before retention existed.
const FROM = "0112_analytics_exports";

const server = inject("databaseUrl");
const name = `ll_upgrade_${randomUUID().slice(0, 8)}`;
const url = Object.assign(new URL(server), { pathname: `/${name}` }).toString();

const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
  entries: { tag: string }[];
};

function olderMigrations(): string {
  const dir = mkdtempSync(join(tmpdir(), "legallabs-older-"));
  cpSync(migrationsFolder, dir, { recursive: true });
  const upTo = journal.entries.findIndex((e) => e.tag === FROM);
  if (upTo < 0) throw new Error(`no migration named ${FROM}`);
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo + 1) }),
  );
  return dir;
}

let admin: pg.Client;
let db: pg.Client;
const ids = { ws: "", user: "", vault: "", doc: "", binned: "", thread: "" };
let before: Record<string, number>;

const TABLES = [
  "core.workspace",
  'core."user"',
  "content.vault",
  "content.document",
  "content.document_version",
  "work.thread",
  "admin.audit_event",
];

async function counts() {
  const found: Record<string, number> = {};
  for (const t of TABLES) {
    found[t] = Number((await db.query(`select count(*) as n from ${t}`)).rows[0]?.n);
  }
  return found;
}

const id = async (sql: string, params: unknown[]) =>
  (await db.query<{ id: string }>(`${sql} returning id`, params)).rows[0]?.id ?? "";

beforeAll(async () => {
  admin = new pg.Client({ connectionString: server });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  await apply(drizzle(pool), { migrationsFolder: olderMigrations() });
  await pool.end();

  db = new pg.Client({ connectionString: url });
  await db.connect();
  ids.ws = await id("insert into core.workspace (slug, name, region) values ($1, $1, 'au')", [
    name.replaceAll("_", "-"),
  ]);
  ids.user = await id(
    `insert into core."user" (workspace_id, email, status) values ($1, 'a@example.test', 'active')`,
    [ids.ws],
  );
  ids.vault = await id(
    "insert into content.vault (workspace_id, owner_id, name) values ($1, $2, 'Deal room')",
    [ids.ws, ids.user],
  );
  const document = () =>
    id(
      `insert into content.document (workspace_id, owner_id, vault_id, name, mime, size)
       values ($1, $2, $3, 'msa.txt', 'text/plain', 3)`,
      [ids.ws, ids.user, ids.vault],
    );
  ids.doc = await document();
  ids.binned = await document();
  await db.query(
    `insert into content.document_version (workspace_id, document_id, sha256, created_by)
     values ($1, $2, $3, $4)`,
    [ids.ws, ids.doc, randomBytes(32), ids.user],
  );
  await db.query(
    `update content.document set deleted_at = now(), deleted_by = $2, deleted_reason = 'user'
      where id = $1`,
    [ids.binned, ids.user],
  );
  ids.thread = await id(
    "insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 'Old question')",
    [ids.ws, ids.user],
  );
  await db.query("select set_config('app.workspace_id', $1, false)", [ids.ws]);
  await db.query("select admin.append_audit_event('workspace.created', 'system', null)");
  before = await counts();

  await migrate(url);
}, 120_000);

afterAll(async () => {
  await db?.end();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
});

describe(`upgrading a populated database from ${FROM}`, () => {
  it("applies every later migration", async () => {
    const { rows } = await db.query<{ n: string }>(
      "select count(*) as n from drizzle.__drizzle_migrations",
    );
    expect(Number(rows[0]?.n)).toBe(journal.entries.length);
  });

  it("keeps every row, and the audit chain unbroken", async () => {
    expect(await counts()).toEqual(before);
    const result = verifyAuditChain(await readAuditChain(db, ids.ws));
    expect(result).toMatchObject({ ok: true });
  });

  it("leaves no table without forced row-level security", async () => {
    const { rows } = await db.query(
      `select n.nspname || '.' || c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p')
          and n.nspname not in ('pg_catalog', 'information_schema', 'public', 'drizzle')
          and n.nspname not like 'pg\\_%'
          and (not c.relrowsecurity or not c.relforcerowsecurity)`,
    );
    expect(rows).toEqual([]);
  });

  it("keeps old rows binned or live, and records later deletions of them", async () => {
    const { rows } = await db.query(
      "select id, deleted_at is not null as binned from content.document order by binned",
    );
    expect(rows).toEqual([
      { id: ids.doc, binned: false },
      { id: ids.binned, binned: true },
    ]);
    await db.query("delete from work.thread where id = $1", [ids.thread]);
    const ledger = await db.query(
      "select object_id, action from retention.deletion_ledger where object_type = 'thread'",
    );
    expect(ledger.rows).toEqual([{ object_id: ids.thread, action: "purged" }]);
  });
});
