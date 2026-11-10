import { describe, expect, it } from "vitest";
import { withTx } from "./db.js";
import { seed } from "./fixtures.js";

const add = `insert into core.session (workspace_id, user_id, token_hash, expires_at)
             values ($1, $2, sha256(gen_random_uuid()::text::bytea), now() + $3::interval)`;

describe("session lifetime caps", () => {
  it("lets a member's session last 7 days, and no longer", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      expect(await tx.error(add, [s.acme, s.ben, "7 days"])).toBeUndefined();
      expect(await tx.error(add, [s.acme, s.ben, "7 days 1 second"])).toMatch(/lifetime cap/);
    });
  });

  it("lets a guest's session last 24 hours, and no longer", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.gia, s.acme);
      expect(await tx.error(add, [s.acme, s.gia, "24 hours"])).toBeUndefined();
      expect(await tx.error(add, [s.acme, s.gia, "24 hours 1 second"])).toMatch(/lifetime cap/);
    });
  });

  it("gives service accounts no sessions at all", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { id } = await tx.one<{ id: string }>(
        `insert into core."user" (workspace_id, email, status, kind)
         values ($1, 'svc_sync@acme.test', 'active', 'service') returning id`,
        [s.acme],
      );
      expect(await tx.error(add, [s.acme, id, "1 hour"])).toMatch(/lifetime cap/);
    });
  });

  it("does not let the app extend a session afterwards", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error("update core.session set expires_at = now() + interval '1 year'"),
      ).toMatch(/permission denied/);
    });
  });
});
