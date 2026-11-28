import { describe, expect, it } from "vitest";
import { withTx } from "./db.js";
import { seed } from "./fixtures.js";

describe("who may set up single sign-on", () => {
  it("keeps writes to full administrators, whatever the app asks", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.asOwner();
      await tx.rows("delete from core.oidc_provider where workspace_id = $1", [s.acme]);
      await tx.rows(`update core."user" set extra_permissions = '{admin.config}' where id = $1`, [
        s.ben,
      ]);
      const add = `insert into core.oidc_provider (workspace_id, issuer, client_id)
                   values ($1, 'https://idp.test', 'x') returning link_by_email`;
      await tx.as(s.ben, s.acme);
      expect(await tx.error(add, [s.acme])).toMatch(/row-level security/);
      expect(await tx.error("select core.set_oidc_client_secret('sealed:v1:x')")).toMatch(
        /not allowed/,
      );
      await tx.as(s.ana, s.acme);
      // Email matching has to be asked for (SEC-006).
      expect(await tx.rows(add, [s.acme])).toEqual([{ link_by_email: false }]);
      expect(await tx.error("select core.set_oidc_client_secret('plain')")).toMatch(/sealed/);
      expect(await tx.error("select core.set_oidc_client_secret('sealed:v1:x')")).toBeUndefined();
    });
  });
});
