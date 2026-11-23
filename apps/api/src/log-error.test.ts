import { afterAll, describe, expect, it } from "vitest";
import { describeError } from "./log-error.js";
import { testPool } from "./test-db.js";

/*
 * Pen-test P-12 (SEC-034, SEC-042): secrets and client content must not reach the log. The 500
 * handler used to print the error object, and a real database error carries the failing row.
 */

const pool = testPool();
afterAll(() => pool.end());

describe("P-12 the 500 handler's log line", () => {
  it("leaves out the row a database error quotes", async () => {
    // A real unique violation: the `detail` property quotes the value that clashed.
    await pool.query("create temp table clash (name text primary key)");
    await pool.query("insert into clash values ('Falcon hostile bid')");
    const err = await pool.query("insert into clash values ('Falcon hostile bid')").catch((e) => e);
    expect((err as { detail: string }).detail).toContain("Falcon hostile bid");

    const line = describeError(err);
    expect(line).not.toContain("Falcon hostile bid");
    expect(line).toContain("duplicate key value violates unique constraint");
  });

  it("does not print a secret hung on an error", () => {
    const err = Object.assign(new Error("provider refused"), {
      request: { headers: { authorization: "Bearer sk-live-ABCDEFGHIJKLMNOP" } },
      cause: { token: "sk-live-ABCDEFGHIJKLMNOP" },
    });
    expect(describeError(err)).not.toContain("sk-live-ABCDEFGHIJKLMNOP");
  });

  it("copes with a thrown non-error", () => {
    expect(describeError("Bearer sk-live-ABCDEFGHIJKLMNOP")).not.toContain("sk-live");
    expect(describeError({ secret: "x" })).toBe("a object was thrown");
  });
});
