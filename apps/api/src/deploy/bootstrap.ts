#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migrate } from "@legallabs/db";
import { ensureBucket, s3ConfigFromEnv } from "@legallabs/storage";
import pg from "pg";

// The one-shot step of an install or upgrade, run as the schema owner before anything serves:
// migrations, the logins the services use and the bucket. Safe to run again.

export interface BootstrapIo {
  env: Record<string, string | undefined>;
  print(line: string): void;
  fetch?: typeof fetch;
}

async function setLogin(client: pg.Client, role: string, password: string, extra = "") {
  const found = await client.query("select 1 from pg_roles where rolname = $1", [role]);
  const verb = found.rowCount ? "alter" : "create";
  // Role statements take no parameters, so the password is quoted by the driver.
  const quoted = client.escapeLiteral(password);
  try {
    await client.query(
      `${verb} role ${client.escapeIdentifier(role)} login ${extra} password ${quoted}`,
    );
  } catch {
    // The driver's error can carry the statement, and with it the password.
    throw new Error(`could not set the login for role ${role}`);
  }
}

export async function bootstrap(io: BootstrapIo): Promise<void> {
  const need = (name: string) => {
    const value = io.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const databaseUrl = need("DATABASE_URL");
  const apiPassword = need("LEGALLABS_DB_PASSWORD");
  const store = s3ConfigFromEnv(io.env);

  await migrate(databaseUrl);
  io.print("ok: migrations applied");

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await setLogin(client, "legallabs_api", apiPassword);
    io.print("ok: the API can log in as legallabs_api");
    if (io.env.TEMPORAL_DB_PASSWORD) {
      // Temporal creates its own two databases, so it needs that one right.
      await setLogin(client, "temporal", io.env.TEMPORAL_DB_PASSWORD, "createdb");
      io.print("ok: Temporal's database login is ready");
    }
  } finally {
    await client.end();
  }

  const buckets = new Set([store.bucket, io.env.S3_ANCHOR_BUCKET || store.bucket]);
  for (const bucket of buckets) {
    await ensureBucket({ ...store, bucket, ...(io.fetch ? { fetch: io.fetch } : {}) });
    io.print(`ok: bucket ${bucket} exists`);
  }
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  try {
    await bootstrap({ env: process.env, print: (line) => console.log(line) });
  } catch (err) {
    console.error(`failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
