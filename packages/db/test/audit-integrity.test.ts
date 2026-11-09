import { describe, expect, it } from "vitest";
import { withTx } from "./db.js";
import { seed } from "./fixtures.js";

describe("audit log is append-only", () => {
  it("denies the app any change", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("update admin.audit_event set action = 'x.y'")).toMatch(
        /permission denied/,
      );
      expect(await tx.error("delete from admin.audit_event")).toMatch(/permission denied/);
      expect(await tx.error("truncate admin.audit_event")).toMatch(/permission denied/);
    });
  });

  it("stops even the database owner with a trigger", async () => {
    await withTx(async (tx) => {
      await seed(tx);
      await tx.asOwner();
      const message = /audit records cannot be changed/;
      expect(await tx.error("update admin.audit_event set action = 'x.y'")).toMatch(message);
      expect(await tx.error("delete from admin.audit_event")).toMatch(message);
      expect(await tx.error("truncate admin.audit_event")).toMatch(message);
      expect(await tx.error("truncate admin.audit_event_default")).toMatch(message);
    });
  });

  it("removes change rights from the role that owns the table", async () => {
    await withTx(async (tx) => {
      const { allowed } = await tx.one<{ allowed: boolean }>(
        `select has_table_privilege('legallabs_definer', 'admin.audit_event', 'update, delete, truncate') as allowed`,
      );
      expect(allowed).toBe(false);
    });
  });
});
