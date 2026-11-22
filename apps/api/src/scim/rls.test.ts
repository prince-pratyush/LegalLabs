import { afterAll, describe, expect, it } from "vitest";
import { asApp } from "../db.js";
import { seedMember, testPool } from "../test-db.js";
import { addAdmin, addPlainMember, seedScim, seedToken, sha256 } from "../test-scim.js";

const pool = testPool();
afterAll(() => pool.end());

const asService = (w: { workspaceId: string; servicePrincipalId: string }) => ({
  userId: w.servicePrincipalId,
  workspaceId: w.workspaceId,
});

describe("the SCIM principal", () => {
  it("can create a member but never give it access", async () => {
    const w = await seedScim(pool);
    await asApp(pool, asService(w), (db) =>
      db.query(`insert into core."user" (workspace_id, email) values ($1, 'new@x.test')`, [
        w.workspaceId,
      ]),
    );
    await expect(
      asApp(pool, asService(w), (db) =>
        db.query(
          `insert into core."user" (workspace_id, email, role_id) values ($1, 'r@x.test', $2)`,
          [w.workspaceId, w.adminRoleId],
        ),
      ),
    ).rejects.toThrow(/cannot set access/);
    await expect(
      asApp(pool, asService(w), (db) =>
        db.query(
          `insert into core."user" (workspace_id, email, kind) values ($1, 'g@x.test', 'guest')`,
          [w.workspaceId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("cannot change a person's role or touch the admin's access", async () => {
    const w = await seedScim(pool);
    await expect(
      asApp(pool, asService(w), (db) =>
        db.query(`update core."user" set role_id = null where id = $1`, [w.adminId]),
      ),
    ).rejects.toThrow(/cannot set access/);
  });

  it("is switched off when SCIM is disabled, and when its token is revoked", async () => {
    const w = await seedScim(pool);
    const insert = () =>
      asApp(pool, asService(w), (db) =>
        db.query(`insert into core."user" (workspace_id, email) values ($1, $2)`, [
          w.workspaceId,
          `p${Math.random()}@x.test`,
        ]),
      );
    await insert();
    await pool.query(`update core.workspace set settings = '{}' where id = $1`, [w.workspaceId]);
    await expect(insert()).rejects.toThrow();
    await pool.query(
      `update core.workspace set settings = '{"scim_enabled": true}' where id = $1`,
      [w.workspaceId],
    );
    await insert();
    await pool.query("update core.api_token set revoked_at = now() where workspace_id = $1", [
      w.workspaceId,
    ]);
    await expect(insert()).rejects.toThrow();
  });

  it("holds no scope-less power: a service user with only a whoami token is not the principal", async () => {
    const w = await seedScim(pool);
    const { rows } = await pool.query<{ id: string }>(
      `insert into core."user" (workspace_id, email, kind) values ($1, 'x@y.invalid', 'service') returning id`,
      [w.workspaceId],
    );
    const other = rows[0]?.id ?? "";
    await seedToken(pool, w.workspaceId, other, ["whoami"]);
    await expect(
      asApp(pool, { userId: other, workspaceId: w.workspaceId }, (db) =>
        db.query(`insert into core."user" (workspace_id, email) values ($1, 'z@x.test')`, [
          w.workspaceId,
        ]),
      ),
    ).rejects.toThrow();
  });

  it("sees and changes only its own workspace", async () => {
    const a = await seedScim(pool);
    const b = await seedScim(pool);
    const rowsSeen = await asApp(pool, asService(a), async (db) => {
      await db.query(`insert into core."group" (workspace_id, name) values ($1, 'A')`, [
        a.workspaceId,
      ]);
      return (await db.query(`select workspace_id from core."user"`)).rows;
    });
    expect(rowsSeen.every((r) => r.workspace_id === a.workspaceId)).toBe(true);
    await expect(
      asApp(pool, asService(a), (db) =>
        db.query(`insert into core."user" (workspace_id, email) values ($1, 'x@b.test')`, [
          b.workspaceId,
        ]),
      ),
    ).rejects.toThrow();
    const touched = await asApp(pool, asService(a), (db) =>
      db.query(`update core."user" set name = 'pwned' where id = $1`, [b.adminId]),
    );
    expect(touched.rowCount).toBe(0);
  });

  it("revokes every session and token of a deprovisioned person", async () => {
    const w = await seedScim(pool);
    const victim = await addPlainMember(pool, w);
    await pool.query(
      `insert into core.session (workspace_id, user_id, token_hash, expires_at)
       values ($1, $2, $3, now() + interval '1 day')`,
      [w.workspaceId, victim, sha256(`s-${Math.random()}`)],
    );
    await seedToken(pool, w.workspaceId, victim, ["whoami"]);
    const counts = await asApp(pool, asService(w), async (db) => {
      const { rows } = await db.query("select * from scim.revoke_user_access($1)", [victim]);
      return rows[0];
    });
    expect(counts).toEqual({ sessions: 1, tokens: 1 });
    const open = await pool.query(
      "select count(*)::int n from core.session where user_id = $1 and revoked_at is null",
      [victim],
    );
    expect(open.rows[0].n).toBe(0);
  });

  it("cannot revoke access in another workspace", async () => {
    const a = await seedScim(pool);
    const b = await seedScim(pool);
    await expect(
      asApp(pool, asService(a), (db) =>
        db.query("select scim.revoke_user_access($1)", [b.adminId]),
      ),
    ).rejects.toThrow();
  });
});

describe("enabling SCIM and issuing tokens", () => {
  it("is refused for a member without admin rights", async () => {
    const w = await seedScim(pool);
    const plain = await addPlainMember(pool, w);
    const who = { userId: plain, workspaceId: w.workspaceId };
    const flip = await asApp(pool, who, (db) =>
      db.query(`update core.workspace set settings = '{"scim_enabled": false}' where id = $1`, [
        w.workspaceId,
      ]),
    );
    expect(flip.rowCount).toBe(0);
    await expect(
      asApp(pool, who, (db) =>
        db.query(
          `insert into core.api_token (workspace_id, principal_id, name, token_hash, scopes, expires_at)
           values ($1, $2, 'x', $3, '{scim}', now() + interval '1 day')`,
          [w.workspaceId, w.servicePrincipalId, sha256(`n-${Math.random()}`)],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("the mass-delete guard", () => {
  it("trips past ten percent in an hour, then refuses until an admin resumes", async () => {
    const w = await seedScim(pool);
    const people: string[] = [];
    for (let i = 0; i < 19; i++) people.push(await addPlainMember(pool, w));
    // 20 members: two removals are exactly 10%, the third crosses it.
    const record = (id: string) =>
      asApp(pool, asService(w), async (db) => {
        const { rows } = await db.query("select * from scim.record_deprovision($1, 'delete')", [
          id,
        ]);
        return rows[0]?.outcome as string;
      });
    expect(await record(people[0] ?? "")).toBe("ok");
    expect(await record(people[1] ?? "")).toBe("ok");
    expect(await record(people[2] ?? "")).toBe("tripped");
    expect(await record(people[3] ?? "")).toBe("paused");
    await expect(
      asApp(pool, asService(w), (db) => db.query("select scim.resume_provisioning()")),
    ).rejects.toThrow(/only an admin/);
    const resumed = await asApp(pool, { userId: w.adminId, workspaceId: w.workspaceId }, (db) =>
      db.query("select scim.resume_provisioning() as r"),
    );
    expect(resumed.rows[0]?.r).toBe(true);
    expect(await record(people[3] ?? "")).toBe("ok");
  });

  it("lets a single departure through even in a tiny workspace", async () => {
    const w = await seedScim(pool);
    const only = await addPlainMember(pool, w);
    const outcome = await asApp(pool, asService(w), async (db) => {
      const { rows } = await db.query("select * from scim.record_deprovision($1, 'active')", [
        only,
      ]);
      return rows[0]?.outcome;
    });
    expect(outcome).toBe("ok");
  });
});

describe("authenticate", () => {
  it("answers for a service user's token only", async () => {
    const w = await seedScim(pool);
    const lookup = (token: string, ip: string | null = "203.0.113.5") =>
      asApp(pool, { userId: null, workspaceId: null }, async (db) => {
        const { rows } = await db.query("select * from scim.authenticate($1, $2)", [
          sha256(token),
          ip,
        ]);
        return rows[0];
      });
    expect(await lookup(w.token)).toMatchObject({
      workspace_id: w.workspaceId,
      principal_id: w.servicePrincipalId,
      enabled: true,
      ip_allowed: true,
    });
    expect(await lookup("made-up")).toBeUndefined();
    const m = await seedMember(pool);
    const humanToken = await seedToken(pool, m.workspaceId, m.userId, ["scim"]);
    expect(await lookup(humanToken)).toBeUndefined();
  });

  it("applies the workspace's IP allow-list", async () => {
    const w = await seedScim(pool, { scim_ip_allowlist: ["198.51.100.0/24", "203.0.113.7"] });
    const allowed = (ip: string | null) =>
      asApp(pool, { userId: null, workspaceId: null }, async (db) => {
        const { rows } = await db.query("select ip_allowed from scim.authenticate($1, $2)", [
          sha256(w.token),
          ip,
        ]);
        return rows[0]?.ip_allowed;
      });
    expect(await allowed("198.51.100.20")).toBe(true);
    expect(await allowed("203.0.113.7")).toBe(true);
    expect(await allowed("192.0.2.1")).toBe(false);
    expect(await allowed(null)).toBe(false);
  });
});

describe("group to role mapping", () => {
  const setup = async () => {
    const w = await seedScim(pool);
    const second = await addAdmin(pool, w);
    const member = await addPlainMember(pool, w);
    const { rows: g } = await pool.query<{ id: string }>(
      `insert into core."group" (workspace_id, name) values ($1, 'Partners') returning id`,
      [w.workspaceId],
    );
    const group = g[0]?.id ?? "";
    await pool.query(
      `insert into core.group_member (workspace_id, group_id, user_id) values ($1,$2,$3)`,
      [w.workspaceId, group, member],
    );
    const { rows: r } = await pool.query<{ id: string }>(
      `insert into core.role (workspace_id, name, permissions) values ($1, 'Reader', '{matters.read}') returning id`,
      [w.workspaceId],
    );
    const reader = r[0]?.id ?? "";
    const as = (userId: string) => ({ userId, workspaceId: w.workspaceId });
    return { w, second, member, group, reader, as };
  };
  const roleOf = async (id: string) =>
    (await pool.query('select role_id, role_from_group from core."user" where id = $1', [id]))
      .rows[0];

  it("applies an ordinary role at once to the people already in the group", async () => {
    const { w, member, group, reader, as } = await setup();
    await asApp(pool, as(w.adminId), (db) =>
      db.query("select scim.request_group_role($1, $2)", [group, reader]),
    );
    expect(await roleOf(member)).toEqual({ role_id: reader, role_from_group: true });
  });

  it("holds an Admin mapping until a different admin confirms it", async () => {
    const { w, second, member, group, as } = await setup();
    const id = await asApp(pool, as(w.adminId), async (db) => {
      const { rows } = await db.query("select scim.request_group_role($1, $2) as id", [
        group,
        w.adminRoleId,
      ]);
      return rows[0]?.id as string;
    });
    expect((await roleOf(member))?.role_id).toBeNull();
    await expect(
      asApp(pool, as(w.adminId), (db) => db.query("select scim.confirm_group_role($1)", [id])),
    ).rejects.toThrow(/different admin/);
    await expect(
      asApp(pool, asService(w), (db) => db.query("select scim.confirm_group_role($1)", [id])),
    ).rejects.toThrow(/only an admin/);
    await asApp(pool, as(second), (db) => db.query("select scim.confirm_group_role($1)", [id]));
    expect(await roleOf(member)).toEqual({ role_id: w.adminRoleId, role_from_group: true });
  });

  it("cannot be forced through by writing the table directly", async () => {
    const { w, group, reader, as } = await setup();
    await expect(
      asApp(pool, as(w.adminId), (db) =>
        db.query(
          `insert into scim.group_role (workspace_id, group_id, role_id, needs_confirmation, state, requested_by)
           values ($1, $2, $3, false, 'active', $4)`,
          [w.workspaceId, group, reader, w.adminId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("takes the role back when the person leaves every mapped group", async () => {
    const { w, member, group, reader, as } = await setup();
    await asApp(pool, as(w.adminId), (db) =>
      db.query("select scim.request_group_role($1, $2)", [group, reader]),
    );
    await asApp(pool, asService(w), async (db) => {
      await db.query("delete from core.group_member where user_id = $1", [member]);
      await db.query("select scim.apply_group_roles($1)", [member]);
    });
    expect(await roleOf(member)).toEqual({ role_id: null, role_from_group: false });
  });

  it("refuses a non-admin who asks for a mapping", async () => {
    const { member, group, reader, as } = await setup();
    await expect(
      asApp(pool, as(member), (db) =>
        db.query("select scim.request_group_role($1, $2)", [group, reader]),
      ),
    ).rejects.toThrow(/only an admin/);
  });
});
