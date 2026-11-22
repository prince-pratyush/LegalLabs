import { describe, expect, it } from "vitest";
import { withTx } from "./db.js";

describe("analytics schema", () => {
  it("materialises a day from raw events", async () => {
    await withTx(async (tx) => {
      const ws = await tx.one<{ id: string }>(
        "insert into core.workspace (slug, name, region) values ('an-test','x','au') returning id",
      );
      const role = await tx.one<{ id: string }>(
        "insert into core.role (workspace_id, name, permissions) values ($1,'A','{*}') returning id",
        [ws.id],
      );
      const u = await tx.one<{ id: string }>(
        `insert into core."user" (workspace_id, email, role_id, status) values ($1,'a@x.test',$2,'active') returning id`,
        [ws.id, role.id],
      );
      await tx.as(u.id, ws.id);
      await tx.one("select analytics.record_usage('web','thread.message','query','threads')");
      await tx.asOwner();
      await tx.one("select analytics.materialise_workspace($1, current_date - 3, current_date)", [
        ws.id,
      ]);
      const rows = await tx.rows("select metrics from analytics.daily where workspace_id = $1", [
        ws.id,
      ]);
      expect(rows).toHaveLength(4);
    });
  });
});
