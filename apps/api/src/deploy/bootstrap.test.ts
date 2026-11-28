import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { bootstrap } from "./bootstrap.js";

const url = inject("databaseUrl");
const pool = new pg.Pool({ connectionString: url, max: 1 });

// Roles belong to the whole cluster, so they are put back for the other tests.
afterAll(async () => {
  await pool.query("alter role legallabs_api nologin password null");
  await pool.query("drop role if exists temporal");
  await pool.end();
});

const requests: string[] = [];
const env = {
  DATABASE_URL: url,
  LEGALLABS_DB_PASSWORD: "it's-a-long-generated-password",
  TEMPORAL_DB_PASSWORD: "another-long-generated-password",
  S3_ENDPOINT: "http://store:8333",
  S3_BUCKET: "legallabs",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
};
const fetchOk = (async (input: Request) => {
  requests.push(`${input.method} ${input.url}`);
  return new Response(null, { status: 200 });
}) as typeof fetch;

describe("bootstrap", () => {
  it("migrates, opens the API role to log in and creates the bucket, as often as asked", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 2; i++) {
      await bootstrap({ env, fetch: fetchOk, print: (line) => lines.push(line) });
    }
    const { rows } = await pool.query<{ rolname: string; login: boolean; createdb: boolean }>(
      `select rolname, rolcanlogin as login, rolcreatedb as createdb from pg_roles
        where rolname in ('legallabs_api', 'temporal') order by 1`,
    );
    expect(rows).toEqual([
      { rolname: "legallabs_api", login: true, createdb: false },
      { rolname: "temporal", login: true, createdb: true },
    ]);
    expect(requests).toContain("PUT http://store:8333/legallabs");
    for (const secret of [env.LEGALLABS_DB_PASSWORD, env.TEMPORAL_DB_PASSWORD]) {
      expect(lines.join("\n")).not.toContain(secret);
    }
  });

  it("refuses to run without the API role's password", async () => {
    await expect(
      bootstrap({ env: { ...env, LEGALLABS_DB_PASSWORD: "" }, print: () => {} }),
    ).rejects.toThrow(/LEGALLABS_DB_PASSWORD/);
  });
});
