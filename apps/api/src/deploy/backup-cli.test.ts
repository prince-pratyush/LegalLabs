import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@legallabs/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Bucket } from "./backup.js";
import { run } from "./backup-cli.js";

const server = inject("databaseUrl");
const named = (name: string) => {
  const url = new URL(server);
  url.pathname = `/${name}`;
  return url.toString();
};
const suffix = randomUUID().slice(0, 8);
const live = `ll_cli_${suffix}`;
const clean = `ll_cli_clean_${suffix}`;

async function sql(url: string, text: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(text, params)).rows;
  } finally {
    await client.end();
  }
}

const root = mkdtempSync(join(tmpdir(), "legallabs-cli-"));
const backups = join(root, "backups");
const config = join(root, "config");
const empty: Bucket = {
  async *list() {},
  get: async () => null,
  put: async () => {},
  delete: async () => {},
};
const lines: string[] = [];
const call = (database: string, ...args: string[]) =>
  run(args, {
    env: {
      DATABASE_URL: named(database),
      LEGALLABS_BACKUP_PASSPHRASE: "a passphrase long enough",
      BACKUP_DIR: backups,
      CONFIG_DIR: config,
    },
    bucket: empty,
    print: (line) => lines.push(line),
  });
const written = (prefix: string) =>
  readdirSync(backups)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => join(backups, name));

let thread = "";

beforeAll(async () => {
  for (const name of [live, clean]) await sql(server, `create database ${name}`);
  await migrate(named(live));
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, ".env"), "LEGALLABS_SECRETS_KEY=only-in-the-backup\n");
  const [ws] = await sql(
    named(live),
    "insert into core.workspace (slug, name, region) values ($1, $1, 'au') returning id",
    [`cli-${suffix}`],
  );
  const [user] = await sql(
    named(live),
    `insert into core."user" (workspace_id, email, status) values ($1, 'a@example.test', 'active')
     returning id`,
    [ws.id],
  );
  const [t] = await sql(
    named(live),
    "insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 't') returning id",
    [ws.id, user.id],
  );
  thread = t.id;
});

afterAll(async () => {
  for (const name of [live, clean])
    await sql(server, `drop database if exists ${name} with (force)`);
});

describe("legallabs backup", () => {
  it("writes one encrypted file, readable by its owner only, and verifies it", async () => {
    expect(await call(live, "create")).toBe(0);
    const [file = ""] = written("legallabs-");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file).includes(Buffer.from("only-in-the-backup"))).toBe(false);
    expect(await call(live, "verify", file)).toBe(0);
    expect(lines.join("\n")).toContain("ok: the backup restores");
  });

  it("restores a clean database, deleting again what the exported record says", async () => {
    const [file = ""] = written("legallabs-");
    await sql(named(live), "delete from work.thread where id = $1", [thread]);
    expect(await call(live, "ledger")).toBe(0);
    const [ledger = ""] = written("deletions-");

    expect(await call(clean, "restore", file)).toBe(1);
    expect(lines.at(-1)).toContain("no record of later deletions");
    expect(await call(clean, "restore", file, "--ledger", ledger)).toBe(0);
    expect(await sql(named(clean), "select 1 from work.thread")).toEqual([]);
    expect(lines.join("\n")).toContain(`purged thread ${thread}`);
  });

  it("hands back the settings and keys the backup holds", async () => {
    const [file = ""] = written("legallabs-");
    expect(await call(live, "keys", file)).toBe(0);
    const [folder = ""] = written("keys-");
    expect(readFileSync(join(folder, ".env"), "utf8")).toContain("only-in-the-backup");
    expect(statSync(join(folder, ".env")).mode & 0o777).toBe(0o600);
    expect(lines.join("\n")).not.toContain("only-in-the-backup");
  });

  it("removes backups past the days kept, and nothing else", async () => {
    const old = join(backups, "legallabs-20200101T000000Z.tar.gpg");
    const other = join(backups, "notes.txt");
    writeFileSync(old, "x");
    writeFileSync(other, "x");
    expect(await call(live, "create")).toBe(0);
    expect(written("legallabs-")).not.toContain(old);
    expect(written("notes")).toEqual([other]);
  });

  it("refuses to run without a passphrase", async () => {
    const code = await run(["create"], {
      env: { DATABASE_URL: named(live) },
      bucket: empty,
      print: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines.at(-1)).toContain("LEGALLABS_BACKUP_PASSPHRASE");
  });
});
