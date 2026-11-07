import { describe, expect, inject, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { withTx } from "./db.js";

describe("migrations", () => {
  it("can be run again without changing anything", async () => {
    await migrate(inject("databaseUrl"));
    await withTx(async (tx) => {
      const { count } = await tx.one<{ count: string }>(
        "select count(*) from drizzle.__drizzle_migrations",
      );
      const before = Number(count);
      expect(before).toBeGreaterThan(0);
      await migrate(inject("databaseUrl"));
      const after = await tx.one<{ count: string }>(
        "select count(*) from drizzle.__drizzle_migrations",
      );
      expect(Number(after.count)).toBe(before);
    });
  });
});

describe("app role", () => {
  it("cannot bypass row-level security or own anything", async () => {
    await withTx(async (tx) => {
      const role = await tx.one(
        "select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = 'legallabs_app'",
      );
      expect(role).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
      });
      const owned = await tx.rows(
        "select relname from pg_class where relowner = 'legallabs_app'::regrole",
      );
      expect(owned).toEqual([]);
    });
  });
});

describe("core.uuid7", () => {
  it("makes version 7 IDs stamped with the current time", async () => {
    await withTx(async (tx) => {
      await tx.as(null, null);
      const { id } = await tx.one<{ id: string }>("select core.uuid7()::text as id");
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const ms = Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
      expect(Math.abs(ms - Date.now())).toBeLessThan(5_000);
    });
  });
});

describe("request settings", () => {
  it("read as empty when a request has not set them", async () => {
    await withTx(async (tx) => {
      await tx.as(null, null);
      const row = await tx.one(
        "select core.current_user_id() as user_id, core.current_workspace_id() as workspace_id",
      );
      expect(row).toEqual({ user_id: null, workspace_id: null });
    });
  });
});
