import type pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { testPool } from "../test-db.js";
import { assertSafeDeployment, tablesWithoutRls, unsafeSettings } from "./posture.js";

const pool = testPool();
afterAll(() => pool.end());

const SAFE = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://legallabs_api:4f9c2a7d81b3e6054f9c2a7d@postgres:5432/legallabs",
  S3_ACCESS_KEY_ID: "ll8f2c1a9b7d3e",
  S3_SECRET_ACCESS_KEY: "9a1b3c5d7e9f0a2b4c6d8e0f1a3b5c7d",
  LEGALLABS_SECRETS_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7)).toString(
    "base64",
  ),
  LEGALLABS_MFA_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 5)).toString("base64"),
  LEGALLABS_PUBLIC_URL: "https://legal.example.test",
};

describe("unsafeSettings", () => {
  it("accepts generated values", () => {
    expect(unsafeSettings(SAFE)).toEqual([]);
  });

  it.each([
    ["DATABASE_URL", "postgres://legallabs_api:postgres@db/legallabs"],
    ["DATABASE_URL", "postgres://legallabs_api:short@db/legallabs"],
    ["S3_ACCESS_KEY_ID", "minioadmin"],
    ["S3_SECRET_ACCESS_KEY", "changeme"],
    ["LEGALLABS_SECRETS_KEY", Buffer.alloc(32).toString("base64")],
    ["LEGALLABS_MFA_KEY", "<generate-me>"],
    ["LEGALLABS_PUBLIC_URL", "http://legal.example.test"],
    ["LEGALLABS_PUBLIC_URL", ""],
    ["OIDC_INSECURE_DEV", "1"],
  ])("refuses an unsafe %s without printing it", (name, value) => {
    const found = unsafeSettings({ ...SAFE, [name]: value });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(name);
    if (value.length > 3) expect(found[0]).not.toContain(value);
  });
});

describe("tablesWithoutRls", () => {
  it("passes a migrated database", async () => {
    expect(await tablesWithoutRls(pool)).toEqual([]);
  });

  it("names a table whose row-level security was turned off", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("alter table content.document disable row level security");
      expect(await tablesWithoutRls(client as unknown as pg.Pool)).toEqual(["content.document"]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("assertSafeDeployment", () => {
  const privateBuckets = async () => [] as string[];

  it("lets a safe production deployment start", async () => {
    await expect(assertSafeDeployment(SAFE, pool, privateBuckets)).resolves.toBeUndefined();
  });

  it("refuses a public bucket, naming it", async () => {
    await expect(assertSafeDeployment(SAFE, pool, async () => ["files"])).rejects.toThrow(
      /bucket files allows anonymous access/,
    );
  });

  it("lists every problem at once", async () => {
    const env = { ...SAFE, S3_SECRET_ACCESS_KEY: "changeme" };
    await expect(assertSafeDeployment(env, pool, async () => ["files"])).rejects.toThrow(
      /S3_SECRET_ACCESS_KEY[\s\S]*bucket files/,
    );
  });

  it("still names the other problems when the store cannot be checked", async () => {
    const env = { ...SAFE, S3_SECRET_ACCESS_KEY: "changeme" };
    const refused = async () => {
      throw new Error("object store HEAD failed with 403");
    };
    await expect(assertSafeDeployment(env, pool, refused)).rejects.toThrow(
      /S3_SECRET_ACCESS_KEY[\s\S]*could not be checked: object store HEAD failed with 403/,
    );
  });

  it("does nothing outside production", async () => {
    const never = async () => {
      throw new Error("probed");
    };
    await expect(assertSafeDeployment({}, pool, never)).resolves.toBeUndefined();
  });
});
