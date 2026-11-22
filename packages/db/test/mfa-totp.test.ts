import { describe, expect, it } from "vitest";
import { withTx } from "./db.js";
import { seed } from "./fixtures.js";

const secret = "\\x0102030405";

describe("authenticator secrets", () => {
  it("cannot be read or written by the app, even by an admin", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      await tx.rows("select core.mfa_totp_begin($1)", [secret]);
      for (const table of ["mfa_totp", "mfa_recovery_code", "mfa_pending"]) {
        expect(await tx.error(`select * from core.${table}`)).toMatch(/permission denied/);
        expect(await tx.error(`delete from core.${table}`)).toMatch(/permission denied/);
      }
    });
  });

  it("belong to one person: others read nothing and cannot confirm", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      await tx.rows("select core.mfa_totp_begin($1)", [secret]);
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select * from core.mfa_totp_get()")).toEqual([]);
      expect(await tx.one("select core.mfa_totp_accept(5, true) as ok")).toEqual({ ok: false });
      await tx.as(s.bob, s.acme); // Bob is in another workspace, so he is no member here.
      expect(await tx.rows("select * from core.mfa_totp_get()")).toEqual([]);
    });
  });

  it("accept a time step only once, and only after the secret is confirmed", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      await tx.rows("select core.mfa_totp_begin($1)", [secret]);
      // Not confirmed yet, so it is not a login factor.
      expect(await tx.one("select core.mfa_totp_accept(10, false) as ok")).toEqual({ ok: false });
      expect(await tx.one("select core.mfa_totp_accept(10, true) as ok")).toEqual({ ok: true });
      expect(await tx.one("select core.mfa_totp_accept(10, false) as ok")).toEqual({ ok: false });
      expect(await tx.one("select core.mfa_totp_accept(9, false) as ok")).toEqual({ ok: false });
      expect(await tx.one("select core.mfa_totp_accept(11, false) as ok")).toEqual({ ok: true });
      expect(await tx.one("select confirmed, last_counter from core.mfa_totp_get()")).toEqual({
        confirmed: true,
        last_counter: "11",
      });
    });
  });

  it("are not replaced once confirmed, but may be restarted before", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      await tx.rows("select core.mfa_totp_begin($1)", [secret]);
      await tx.rows("select core.mfa_totp_begin('\\x0a0b')");
      await tx.rows("select core.mfa_totp_accept(10, true)");
      expect(await tx.error("select core.mfa_totp_begin('\\x0c0d')")).toMatch(/already enrolled/);
      expect(await tx.one("select core.mfa_totp_delete() as ok")).toEqual({ ok: true });
      await tx.rows("select core.mfa_totp_begin('\\x0c0d')");
    });
  });

  it("are unavailable to a suspended person", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.sue, s.acme);
      expect(await tx.error("select core.mfa_totp_begin('\\x01')")).toMatch(/not an active member/);
    });
  });
});

describe("recovery codes", () => {
  const hash = (n: number) => `'\\x${n.toString(16).padStart(2, "0").repeat(32)}'::bytea`;

  it("work once each and are replaced as a set", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      await tx.rows(`select core.mfa_recovery_replace(array[${hash(1)}, ${hash(2)}])`);
      expect(await tx.one(`select core.mfa_recovery_consume(${hash(1)}) as ok`)).toEqual({
        ok: true,
      });
      expect(await tx.one(`select core.mfa_recovery_consume(${hash(1)}) as ok`)).toEqual({
        ok: false,
      });
      expect(await tx.one(`select core.mfa_recovery_consume(${hash(9)}) as ok`)).toEqual({
        ok: false,
      });
      await tx.rows(`select core.mfa_recovery_replace(array[${hash(3)}])`);
      // The old set is gone, including its unused code.
      expect(await tx.one(`select core.mfa_recovery_consume(${hash(2)}) as ok`)).toEqual({
        ok: false,
      });
      expect(await tx.one(`select core.mfa_recovery_consume(${hash(3)}) as ok`)).toEqual({
        ok: true,
      });
    });
  });

  it("cannot be spent by someone else", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      await tx.rows(`select core.mfa_recovery_replace(array[${hash(1)}])`);
      await tx.as(s.ben, s.acme);
      expect(await tx.one(`select core.mfa_recovery_consume(${hash(1)}) as ok`)).toEqual({
        ok: false,
      });
    });
  });
});

describe("a pending sign-in", () => {
  const token = "'\\x" + "ab".repeat(32) + "'::bytea";

  it("resolves before any identity exists and is retired by five wrong guesses", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      const { id } = await tx.one<{ id: string }>(
        `select core.mfa_pending_create('verify', ${token}, 600) as id`,
      );
      await tx.as(null, null);
      expect(
        await tx.rows(`select user_id, purpose from core.mfa_pending_resolve(${token})`),
      ).toEqual([{ user_id: s.ana, purpose: "verify" }]);
      for (let i = 0; i < 5; i++) await tx.rows("select core.mfa_pending_strike($1)", [id]);
      expect(await tx.rows(`select * from core.mfa_pending_resolve(${token})`)).toEqual([]);
      expect(await tx.one("select core.mfa_pending_consume($1) as ok", [id])).toEqual({
        ok: false,
      });
    });
  });

  it("is consumed once", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      const { id } = await tx.one<{ id: string }>(
        `select core.mfa_pending_create('enrol', ${token}, 600) as id`,
      );
      expect(await tx.one("select core.mfa_pending_consume($1) as ok", [id])).toEqual({ ok: true });
      expect(await tx.one("select core.mfa_pending_consume($1) as ok", [id])).toEqual({
        ok: false,
      });
      expect(await tx.rows(`select * from core.mfa_pending_resolve(${token})`)).toEqual([]);
    });
  });

  it("stops resolving once the person is suspended", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      await tx.rows(`select core.mfa_pending_create('verify', ${token}, 600)`);
      await tx.asOwner();
      await tx.rows(`update core."user" set status = 'suspended' where id = $1`, [s.ana]);
      await tx.as(null, null);
      expect(await tx.rows(`select * from core.mfa_pending_resolve(${token})`)).toEqual([]);
    });
  });

  it("cannot be made for someone who is not the current person's workspace member", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(null, null);
      expect(await tx.error(`select core.mfa_pending_create('verify', ${token}, 600)`)).toMatch(
        /not an active member/,
      );
      await tx.as(s.ana, s.acme);
      expect(await tx.error(`select core.mfa_pending_create('verify', ${token}, 99999)`)).toMatch(
        /out of range/,
      );
    });
  });
});

describe("the workspace policy setting", () => {
  it("accepts the four policies and refuses anything else", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      for (const policy of ["off", "admins", "all", "all_incl_guests"]) {
        await tx.rows(
          `update core.workspace set settings = jsonb_build_object('mfa', $1::text) where id = $2`,
          [policy, s.acme],
        );
      }
      expect(
        await tx.error(`update core.workspace set settings = '{"mfa":"sometimes"}' where id = $1`, [
          s.acme,
        ]),
      ).toMatch(/workspace_mfa_policy/);
    });
  });
});
