import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { type Seed, seed } from "./fixtures.js";

const hash = () => createHash("sha256").update(randomBytes(32)).digest();

const create = "select core.create_invite($1, $2, 3600)";
const accept = "select * from core.accept_invite($1, 'argon-hash')";

async function roleIds(tx: Tx, s: Seed) {
  await tx.asOwner();
  const rows = await tx.rows<{ id: string; name: string }>(
    "select id, name from core.role where workspace_id = $1",
    [s.acme],
  );
  const of = (name: string) => rows.find((r) => r.name === name)?.id as string;
  return { admin: of("Admin"), user: of("User") };
}

async function invited(tx: Tx, s: Seed, roleId: string, extra = "") {
  await tx.asOwner();
  const row = await tx.one<{ id: string }>(
    `insert into core."user" (workspace_id, email, role_id, status)
     values ($1, $2, $3, 'invited') returning id`,
    [s.acme, `new${extra}${randomBytes(3).toString("hex")}@acme.test`, roleId],
  );
  return row.id;
}

describe("the last administrator", () => {
  it("cannot be touched by someone who only manages users", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const r = await roleIds(tx, s);
      await tx.as(s.dee, s.acme);
      expect(
        await tx.error(`update core."user" set status = 'suspended' where id = $1`, [s.ana]),
      ).toMatch(/you do not hold/);
      expect(
        await tx.error(`update core."user" set role_id = $2 where id = $1`, [s.ana, r.user]),
      ).toMatch(/you do not hold/);
    });
  });

  // An identity provider is not a person, so only this rule stands between it and a locked
  // out workspace.
  it("cannot be removed by an identity provider until there is another", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const r = await roleIds(tx, s);
      await tx.asOwner();
      await tx.rows(
        `update core.workspace set settings = settings || '{"scim_enabled": true}' where id = $1`,
        [s.acme],
      );
      const bot = await tx.one<{ id: string }>(
        `insert into core."user" (workspace_id, email, kind, status)
         values ($1, 'bot@scim.invalid', 'service', 'active') returning id`,
        [s.acme],
      );
      await tx.rows(
        `insert into core.api_token (workspace_id, principal_id, name, token_hash, scopes, expires_at)
         values ($1, $2, 't', $3, '{scim}', now() + interval '1 day')`,
        [s.acme, bot.id, hash()],
      );
      const suspend = `update core."user" set status = 'deprovisioned' where id = $1`;
      await tx.as(bot.id, s.acme);
      expect(await tx.error(suspend, [s.ana])).toMatch(/LAST_ADMIN/);
      await tx.asOwner();
      await tx.rows(
        `insert into core."user" (workspace_id, email, role_id, status)
         values ($1, 'eve@acme.test', $2, 'active')`,
        [s.acme, r.admin],
      );
      await tx.as(bot.id, s.acme);
      expect(await tx.error(suspend, [s.ana])).toBeUndefined();
      await tx.asOwner();
      expect(await tx.one(`select status from core."user" where id = $1`, [s.ana])).toEqual({
        status: "deprovisioned",
      });
    });
  });

  it("keeps the built-in Admin role's permissions fixed", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const r = await roleIds(tx, s);
      await tx.rows("update core.role set builtin = true where id = $1", [r.admin]);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error("update core.role set permissions = '{}' where id = $1", [r.admin]),
      ).toMatch(/built-in/);
      expect(await tx.error("delete from core.role where id = $1", [r.admin])).toMatch(/built-in/);
    });
  });
});

describe("group membership", () => {
  const add = "insert into core.group_member (workspace_id, group_id, user_id) values ($1, $2, $3)";
  const remove = "delete from core.group_member where group_id = $1 and user_id = $2";

  it("is never one's own to change", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await tx.error(add, [s.acme, s.groups.litTeam, s.ana])).toMatch(/OWN_ACCOUNT/);
      expect(await tx.error(remove, [s.groups.corpTeam, s.ana])).toMatch(/OWN_ACCOUNT/);
    });
  });

  it("of a group a wall names takes admin.matters", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      // dee manages users but not matters; a wall allows corp-team.
      await tx.as(s.dee, s.acme);
      expect(await tx.error(add, [s.acme, s.groups.corpTeam, s.cal])).toMatch(/WALLED_GROUP/);
      expect(await tx.error(remove, [s.groups.corpTeam, s.ben])).toMatch(/WALLED_GROUP/);
      expect(await tx.error(add, [s.acme, s.groups.everyone, s.cal])).toBeUndefined();
      await tx.as(s.ana, s.acme);
      expect(await tx.error(add, [s.acme, s.groups.corpTeam, s.cal])).toBeUndefined();
    });
  });
});

describe("people an identity provider manages", () => {
  it("keeps their status, and a mapped role, out of an administrator's hands", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const r = await roleIds(tx, s);
      await tx.asOwner();
      await tx.rows(`update core."user" set scim_managed = true where id = $1`, [s.ben]);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error(`update core."user" set status = 'suspended' where id = $1`, [s.ben]),
      ).toMatch(/SCIM_MANAGED/);
      await tx.asOwner();
      await tx.rows(`update core."user" set role_from_group = true where id = $1`, [s.ben]);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error(`update core."user" set role_id = $2 where id = $1`, [s.ben, r.admin]),
      ).toMatch(/SCIM_MANAGED/);
    });
  });
});

describe("invitation links", () => {
  it("are out of the app role's reach as a table", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("select * from core.user_invite")).toMatch(/permission denied/);
    });
  });

  it("set a password once, for the person invited", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const r = await roleIds(tx, s);
      const who = await invited(tx, s, r.user);
      const token = hash();
      await tx.as(s.ana, s.acme);
      await tx.rows(create, [who, token]);
      await tx.as(null, null);
      expect(await tx.rows(accept, [token])).toMatchObject([
        { workspace_id: s.acme, user_id: who },
      ]);
      expect(await tx.rows(accept, [token])).toEqual([]);
      await tx.asOwner();
      expect(await tx.one(`select status from core."user" where id = $1`, [who])).toEqual({
        status: "active",
      });
      expect(
        await tx.one("select password_hash from core.password_credential where user_id = $1", [
          who,
        ]),
      ).toEqual({ password_hash: "argon-hash" });
    });
  });

  it("are replaced by a newer one, expire, and die if the role or status changes", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const r = await roleIds(tx, s);
      const who = await invited(tx, s, r.user);
      const first = hash();
      const second = hash();
      await tx.as(s.ana, s.acme);
      await tx.rows(create, [who, first]);
      await tx.rows(create, [who, second]);
      await tx.as(null, null);
      expect(await tx.rows(accept, [first])).toEqual([]);

      await tx.asOwner();
      await tx.rows(`update core.user_invite set expires_at = now() - interval '1 second'`);
      await tx.as(null, null);
      expect(await tx.rows(accept, [second])).toEqual([]);

      const third = hash();
      await tx.as(s.ana, s.acme);
      await tx.rows(create, [who, third]);
      // Promoted before accepting: the link must not become an administrator's way in.
      await tx.asOwner();
      await tx.rows(`update core."user" set role_id = $2 where id = $1`, [who, r.admin]);
      await tx.as(null, null);
      expect(await tx.rows(accept, [third])).toEqual([]);

      await tx.asOwner();
      await tx.rows(`update core."user" set role_id = $2, status = 'suspended' where id = $1`, [
        who,
        r.user,
      ]);
      await tx.as(null, null);
      expect(await tx.rows(accept, [third])).toEqual([]);
    });
  });

  // As over HTTP, where accepting runs with no workspace set.
  it("die if the role has since been given administrator rights", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const r = await roleIds(tx, s);
      const who = await invited(tx, s, r.user);
      const token = hash();
      await tx.as(s.ana, s.acme);
      await tx.rows(create, [who, token]);
      await tx.asOwner();
      await tx.rows("update core.role set permissions = '{admin.users}' where id = $1", [r.user]);
      await tx.as(null, null);
      expect(await tx.rows(accept, [token])).toEqual([]);
    });
  });

  it("do not outlive the standing of whoever sent them", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const r = await roleIds(tx, s);
      await tx.asOwner();
      const eve = await tx.one<{ id: string }>(
        `insert into core."user" (workspace_id, email, role_id, status)
         values ($1, 'eve@acme.test', $2, 'active') returning id`,
        [s.acme, r.admin],
      );
      const issue = async () => {
        const who = await invited(tx, s, r.user);
        const token = hash();
        await tx.as(eve.id, s.acme);
        await tx.rows(create, [who, token]);
        await tx.asOwner();
        return token;
      };
      const refused = async (token: Buffer) => {
        await tx.as(null, null);
        expect(await tx.rows(accept, [token])).toEqual([]);
        await tx.asOwner();
      };
      const setEve = (sql: string, value: unknown) =>
        tx.rows(`update core."user" set ${sql} = $2 where id = $1`, [eve.id, value]);

      // Suspended or removed, by any route, and the link stays dead if they come back.
      for (const status of ["suspended", "deprovisioned"]) {
        const token = await issue();
        await setEve("status", status);
        await refused(token);
        await setEve("status", "active");
        await refused(token);
      }
      // Demoted below admin.users.
      const demoted = await issue();
      await setEve("role_id", r.user);
      await refused(demoted);
      await setEve("role_id", r.admin);
      // The sender's role edited, which no user row records.
      const edited = await issue();
      await tx.rows("update core.role set permissions = '{threads.use}' where id = $1", [r.admin]);
      await refused(edited);
    });
  });

  it("are never made for administrators, active people, other workspaces or by a plain member", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const r = await roleIds(tx, s);
      const admin = await invited(tx, s, r.admin);
      const plain = await invited(tx, s, r.user);
      await tx.as(s.ana, s.acme);
      expect(await tx.error(create, [admin, hash()])).toMatch(/cannot be invited/);
      expect(await tx.error(create, [s.ben, hash()])).toMatch(/cannot be invited/);
      expect(await tx.error(create, [s.bob, hash()])).toMatch(/cannot be invited/);
      await tx.as(s.ben, s.acme);
      expect(await tx.error(create, [plain, hash()])).toMatch(/not allowed/);
    });
  });
});
