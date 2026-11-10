import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createAuth } from "./auth/auth.js";
import { assertRestrictedRole } from "./database-role.js";
import { PASSWORD, seedMember, testPool } from "./test-db.js";

const owner = testPool();
let api: pg.Pool;

beforeAll(async () => {
  const secret = randomUUID();
  await owner.query(`alter role legallabs_api login password '${secret}'`);
  const url = new URL(inject("databaseUrl"));
  url.username = "legallabs_api";
  url.password = secret;
  api = new pg.Pool({ connectionString: url.toString(), max: 2 });
});

afterAll(async () => {
  await api.end();
  await owner.query("alter role legallabs_api nologin");
  await owner.end();
});

describe("the API's database role", () => {
  it("is refused when it can bypass row-level security", async () => {
    await expect(assertRestrictedRole(owner)).rejects.toThrow(/refusing to run/);
  });

  it("is accepted when restricted", async () => {
    await expect(assertRestrictedRole(api)).resolves.toBeUndefined();
  });

  it("reads nothing until it takes on the app role", async () => {
    await expect(api.query(`select * from core."user"`)).rejects.toThrow(/permission denied/);
  });

  it("can still sign someone in", async () => {
    const m = await seedMember(owner);
    const result = await createAuth(api).login(
      { workspace: m.slug, email: m.email, password: PASSWORD },
      { ip: null, userAgent: null },
    );
    expect(result?.principal.userId).toBe(m.userId);
  });
});
