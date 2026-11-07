import { describe, expect, it } from "vitest";
import { withTx } from "./db.js";
import { seed } from "./fixtures.js";

const hash = "sha256(convert_to($1, 'utf8'))";

describe("login lookups, which run before anyone is known", () => {
  it("finds a person by workspace and email, ignoring case", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(null, null);
      const rows = await tx.rows("select * from core.find_login_user($1, $2)", [
        s.slugs.acme,
        "ANA@acme.test",
      ]);
      expect(rows).toEqual([{ user_id: s.ana, workspace_id: s.acme, status: "active" }]);
    });
  });

  it("finds nobody for an email in a different workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(null, null);
      expect(
        await tx.rows("select * from core.find_login_user($1, $2)", [
          s.slugs.acme,
          "bob@beta.test",
        ]),
      ).toEqual([]);
    });
  });

  it("never offers a service account for interactive login", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.rows(
        `insert into core."user" (workspace_id, email, status, kind) values ($1, 'svc_sync@acme.test', 'active', 'service')`,
        [s.acme],
      );
      await tx.as(null, null);
      expect(
        await tx.rows("select * from core.find_login_user($1, $2)", [
          s.slugs.acme,
          "svc_sync@acme.test",
        ]),
      ).toEqual([]);
    });
  });

  it("resolves a live session to its person and workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(null, null);
      const rows = await tx.rows(
        `select user_id, workspace_id from core.resolve_session(${hash})`,
        [s.secrets.ana],
      );
      expect(rows).toEqual([{ user_id: s.ana, workspace_id: s.acme }]);
    });
  });

  it("rejects expired and revoked sessions, and those of suspended people", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.rows(`update core.session set revoked_at = now() where token_hash = ${hash}`, [
        s.secrets.ben,
      ]);
      await tx.as(null, null);
      for (const secret of [s.secrets.expired, s.secrets.ben, s.secrets.sue, "never-issued"]) {
        expect(await tx.rows(`select * from core.resolve_session(${hash})`, [secret])).toEqual([]);
      }
    });
  });

  it("resolves an API token to its principal and scopes", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(null, null);
      const rows = await tx.rows(
        `select principal_id, workspace_id, scopes from core.resolve_api_token(${hash})`,
        [s.secrets.anaToken],
      );
      expect(rows).toEqual([{ principal_id: s.ana, workspace_id: s.acme, scopes: ["audit:read"] }]);
    });
  });

  it("rejects a revoked API token", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.rows(`update core.api_token set revoked_at = now() where token_hash = ${hash}`, [
        s.secrets.anaToken,
      ]);
      await tx.as(null, null);
      expect(
        await tx.rows(`select * from core.resolve_api_token(${hash})`, [s.secrets.anaToken]),
      ).toEqual([]);
    });
  });
});

describe("revocation", () => {
  it("cannot be undone, for a session or a token", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      await tx.rows(`update core.session set revoked_at = now() where token_hash = ${hash}`, [
        s.secrets.ana,
      ]);
      await tx.rows(`update core.api_token set revoked_at = now() where token_hash = ${hash}`, [
        s.secrets.anaToken,
      ]);
      expect(
        await tx.error(`update core.session set revoked_at = null where token_hash = ${hash}`, [
          s.secrets.ana,
        ]),
      ).toMatch(/revocation is final/);
      expect(
        await tx.error(`update core.api_token set revoked_at = null where token_hash = ${hash}`, [
          s.secrets.anaToken,
        ]),
      ).toMatch(/revocation is final/);
    });
  });

  it("does not let the app rewrite when MFA happened", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      expect(await tx.error("update core.session set mfa_at = now()")).toMatch(/permission denied/);
    });
  });
});

describe("sessions and tokens under row-level security", () => {
  it("shows people their own sessions, and admins everyone's in the workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select user_id from core.session")).toEqual([{ user_id: s.ben }]);
      await tx.as(s.ana, s.acme);
      expect(await tx.rows("select id from core.session")).toHaveLength(4);
    });
  });

  it("refuses a token with an unknown scope or a life over 365 days", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const add = `insert into core.api_token (workspace_id, principal_id, name, token_hash, scopes, expires_at)
                   values ($1, $2, 'x', sha256('x'::bytea), $3, now() + $4::interval)`;
      expect(await tx.error(add, [s.acme, s.ana, ["root"], "1 day"])).toMatch(/check constraint/);
      expect(await tx.error(add, [s.acme, s.ana, ["whoami"], "400 days"])).toMatch(
        /check constraint/,
      );
    });
  });
});
