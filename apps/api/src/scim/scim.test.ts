import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { auditTrail, seedMember, testPool } from "../test-db.js";
import {
  addAdmin,
  addPlainMember,
  type ScimWorkspace,
  scimHarness,
  seedScim,
  seedToken,
  sha256,
} from "../test-scim.js";
import { PATCH_URN, USER_URN } from "./schemas.js";

const pool = testPool();
afterAll(() => pool.end());

const actions = async (w: ScimWorkspace) =>
  (await auditTrail(pool, w.workspaceId)).map((r) => r.action as string);

/** A signed-in session for someone already in the workspace, as a bearer token. */
async function session(w: ScimWorkspace, userId: string) {
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `insert into core.session (workspace_id, user_id, token_hash, expires_at)
     values ($1, $2, $3, now() + interval '1 hour')`,
    [w.workspaceId, userId, sha256(token)],
  );
  return token;
}

describe("who may call /scim/v2", () => {
  it("accepts only a live scim-scoped token of a service user", async () => {
    const w = await seedScim(pool);
    const h = scimHarness(pool);
    expect((await h.call(w.token, "GET", "/Users")).status).toBe(200);

    const other = await seedToken(pool, w.workspaceId, w.servicePrincipalId, ["whoami"]);
    const denied = await h.call(other, "GET", "/Users");
    expect(denied.status).toBe(403);
    expect(await actions(w)).toContain("token.used_denied");

    await pool.query("update core.api_token set expires_at = now() - interval '1 second' where token_hash = $1", [
      sha256(w.token),
    ]);
    expect((await h.call(w.token, "GET", "/Users")).status).toBe(401);
  });

  it("refuses a revoked token at once", async () => {
    const w = await seedScim(pool);
    const h = scimHarness(pool);
    await pool.query("update core.api_token set revoked_at = now() where workspace_id = $1", [w.workspaceId]);
    expect((await h.call(w.token, "GET", "/Users")).status).toBe(401);
  });

  it("is closed while an admin has SCIM switched off", async () => {
    const w = await seedScim(pool);
    const h = scimHarness(pool);
    await pool.query(`update core.workspace set settings = '{}' where id = $1`, [w.workspaceId]);
    const r = await h.call(w.token, "GET", "/Users");
    expect(r.status).toBe(403);
    expect(r.body.detail).toMatch(/not enabled/);
  });

  it("holds callers to the workspace's IP allow-list", async () => {
    const w = await seedScim(pool, { scim_ip_allowlist: ["198.51.100.0/24"] });
    expect((await scimHarness(pool, "203.0.113.9").call(w.token, "GET", "/Users")).status).toBe(403);
    expect((await scimHarness(pool, "198.51.100.7").call(w.token, "GET", "/Users")).status).toBe(200);
  });

  it("is not reachable with a person's session, and the token reaches nothing else", async () => {
    const w = await seedScim(pool);
    const h = scimHarness(pool);
    const mine = await session(w, w.adminId);
    expect((await h.call(mine, "GET", "/Users")).status).toBe(401);
    const viaApi = await h.app.request("http://api.test/api/v1/documents", {
      headers: { authorization: `Bearer ${w.token}` },
    });
    expect(viaApi.status).toBe(401);
    const asCookie = await h.app.request("http://api.test/auth/session", {
      headers: { authorization: `Bearer ${w.token}` },
    });
    expect(asCookie.status).toBe(401);
  });

  it("cannot be used to sign in", async () => {
    const w = await seedScim(pool);
    const { rows } = await pool.query<{ email: string }>(
      `select email from core."user" where id = $1`,
      [w.servicePrincipalId],
    );
    const res = await scimHarness(pool).app.request("http://api.test/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: w.slug, email: rows[0]?.email, password: "anything at all" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("workspace isolation", () => {
  it("never shows, changes or deletes another workspace's people or groups", async () => {
    const a = await seedScim(pool);
    const b = await seedScim(pool);
    const h = scimHarness(pool);
    const made = await h.call(a.token, "POST", "/Users", { schemas: [USER_URN], userName: "iso@x.test" });
    const group = await h.call(a.token, "POST", "/Groups", { displayName: "Iso" });
    const seen = await h.call(b.token, "GET", "/Users");
    expect(seen.body.Resources.map((r: { userName: string }) => r.userName)).not.toContain("iso@x.test");
    expect((await h.call(b.token, "GET", `/Users/${made.body.id}`)).status).toBe(404);
    expect((await h.call(b.token, "DELETE", `/Users/${made.body.id}`)).status).toBe(404);
    expect(
      (
        await h.call(b.token, "PATCH", `/Users/${made.body.id}`, {
          schemas: [PATCH_URN],
          Operations: [{ op: "replace", path: "title", value: "x" }],
        })
      ).status,
    ).toBe(404);
    expect((await h.call(b.token, "GET", `/Groups/${group.body.id}`)).status).toBe(404);
    // The same userName is free in the other workspace.
    expect((await h.call(b.token, "POST", "/Users", { schemas: [USER_URN], userName: "iso@x.test" })).status).toBe(201);
    // A member of another workspace cannot be put in a group.
    const stranger = await h.call(b.token, "POST", "/Users", { schemas: [USER_URN], userName: "s@x.test" });
    const bad = await h.call(a.token, "POST", "/Groups", { displayName: "G2", members: [{ value: stranger.body.id }] });
    expect(bad.status).toBe(400);
  });
});

describe("audit", () => {
  it("records created, updated, deactivated and group changes as the service principal", async () => {
    const w = await seedScim(pool);
    const h = scimHarness(pool);
    const u = await h.call(w.token, "POST", "/Users", { schemas: [USER_URN], userName: "aud@x.test" });
    await h.call(w.token, "PATCH", `/Users/${u.body.id}`, {
      schemas: [PATCH_URN],
      Operations: [{ op: "replace", path: "title", value: "T" }],
    });
    await h.call(w.token, "PATCH", `/Users/${u.body.id}`, {
      schemas: [PATCH_URN],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    await h.call(w.token, "POST", "/Groups", { displayName: "Aud", members: [{ value: u.body.id }] });
    const trail = await auditTrail(pool, w.workspaceId);
    const scim = trail.filter((r) => String(r.action).startsWith("scim."));
    expect(scim.map((r) => r.action)).toEqual([
      "scim.user_created",
      "scim.user_updated",
      "scim.user_deactivated",
      "scim.group_synced",
    ]);
    expect(scim.every((r) => r.actor_type === "service" && r.actor_id === w.servicePrincipalId)).toBe(true);
    expect(JSON.stringify(trail)).not.toContain("aud@x.test");
  });
});

describe("deprovisioning", () => {
  it("revokes sessions and tokens the moment a person is deactivated", async () => {
    const w = await seedScim(pool);
    const h = scimHarness(pool);
    const victim = await addPlainMember(pool, w);
    const live = await session(w, victim);
    const live2 = await seedToken(pool, w.workspaceId, victim, ["whoami"]);
    void live2;
    const check = () =>
      h.app.request("http://api.test/auth/session", { headers: { authorization: `Bearer ${live}` } });
    expect((await check()).status).toBe(200);
    const off = await h.call(w.token, "PATCH", `/Users/${victim}`, {
      schemas: [PATCH_URN],
      Operations: [{ op: "Replace", path: "active", value: "False" }],
    });
    expect(off.status).toBe(200);
    expect((await check()).status).toBe(401);
    const left = await pool.query(
      "select count(*)::int n from core.api_token where principal_id = $1 and revoked_at is null",
      [victim],
    );
    expect(left.rows[0].n).toBe(0);
    const row = await pool.query(`select status from core."user" where id = $1`, [victim]);
    expect(row.rows[0].status).toBe("deprovisioned");
  });

  it("does the same on DELETE, and drops the person from groups", async () => {
    const w = await seedScim(pool);
    const h = scimHarness(pool);
    const victim = await addPlainMember(pool, w);
    const live = await session(w, victim);
    const g = await h.call(w.token, "POST", "/Groups", { displayName: "Del", members: [{ value: victim }] });
    expect((await h.call(w.token, "DELETE", `/Users/${victim}`)).status).toBe(204);
    expect(
      (await h.app.request("http://api.test/auth/session", { headers: { authorization: `Bearer ${live}` } })).status,
    ).toBe(401);
    expect((await h.call(w.token, "GET", `/Groups/${g.body.id}`)).body.members).toEqual([]);
  });

  it("cannot reach the workspace's admins' access, kind or role", async () => {
    const w = await seedScim(pool);
    const h = scimHarness(pool);
    const r = await h.call(w.token, "POST", "/Users", {
      schemas: [USER_URN],
      userName: "sneaky@x.test",
      roles: [{ value: "Admin" }],
      kind: "service",
    });
    expect(r.status).toBe(201);
    const row = await pool.query(`select role_id, kind from core."user" where id = $1`, [r.body.id]);
    expect(row.rows[0]).toEqual({ role_id: null, kind: "member" });
  });
});

describe("mass-delete guard", () => {
  it("pauses after more than 10% in an hour, fires the webhook, and holds until an admin resumes", async () => {
    const w = await seedScim(pool);
    const h = scimHarness(pool);
    const people: string[] = [];
    for (let i = 0; i < 19; i++) people.push(await addPlainMember(pool, w));
    const del = (id: string) => h.call(w.token, "DELETE", `/Users/${id}`);
    expect((await del(people[0] ?? "")).status).toBe(204);
    expect((await del(people[1] ?? "")).status).toBe(204);
    const third = await del(people[2] ?? "");
    expect(third.status).toBe(403);
    expect(third.body.detail).toMatch(/paused/i);
    expect(h.events).toEqual([
      { type: "scim.mass_delete_paused", workspaceId: w.workspaceId, count: 3, population: 20 },
    ]);
    // The refused deletion did not happen, and the pause is on the record.
    const still = await pool.query(`select status from core."user" where id = $1`, [people[2]]);
    expect(still.rows[0].status).toBe("active");
    expect(await actions(w)).toContain("scim.mass_delete_paused");
    // Deactivation is held too; creating people still works.
    const off = await h.call(w.token, "PATCH", `/Users/${people[3]}`, {
      schemas: [PATCH_URN],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(off.status).toBe(403);
    expect((await h.call(w.token, "POST", "/Users", { schemas: [USER_URN], userName: "ok@x.test" })).status).toBe(201);
    expect(h.events).toHaveLength(1);

    // Only an admin can lift it, over the session-authenticated admin API.
    const admin = await session(w, w.adminId);
    const plain = await session(w, await addPlainMember(pool, w));
    const resume = (token: string) =>
      h.app.request("http://api.test/api/v1/admin/scim/resume", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await resume(plain)).status).toBe(403);
    expect((await del(people[2] ?? "")).status).toBe(403);
    expect((await resume(admin)).status).toBe(200);
    expect((await del(people[2] ?? "")).status).toBe(204);
  });
});

describe("the admin API", () => {
  const api = (h: ReturnType<typeof scimHarness>, token: string, method: string, path: string, body?: unknown) =>
    h.app.request(`http://api.test/api/v1/admin/scim${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  it("lets an admin turn SCIM on and issue a token that then works, once", async () => {
    const m = await seedMember(pool);
    const w: ScimWorkspace = {
      slug: m.slug,
      workspaceId: m.workspaceId,
      adminId: m.userId,
      adminRoleId: "",
      servicePrincipalId: "",
      token: "",
    };
    const h = scimHarness(pool);
    const admin = await session(w, m.userId);
    expect((await api(h, admin, "POST", "/tokens", { name: "Okta" })).status).toBe(400);
    expect((await api(h, admin, "PUT", "", { enabled: true, ip_allowlist: ["203.0.113.0/24"] })).status).toBe(204);
    const setting = await pool.query("select settings from core.workspace where id = $1", [m.workspaceId]);
    expect(setting.rows[0].settings).toMatchObject({ scim_enabled: true, scim_ip_allowlist: ["203.0.113.0/24"] });
    const made = await api(h, admin, "POST", "/tokens", { name: "Okta" });
    expect(made.status).toBe(201);
    const { token, id } = (await made.json()) as { token: string; id: string };
    expect((await h.call(token, "GET", "/ServiceProviderConfig")).status).toBe(200);
    const status = (await (await api(h, admin, "GET", "")).json()) as { tokens: { id: string }[]; enabled: boolean };
    expect(status.enabled).toBe(true);
    expect(JSON.stringify(status)).not.toContain(token);
    const stored = await pool.query("select token_hash from core.api_token where id = $1", [id]);
    expect(stored.rows[0].token_hash.equals(sha256(token))).toBe(true);
    expect((await api(h, admin, "DELETE", `/tokens/${id}`)).status).toBe(204);
    expect((await h.call(token, "GET", "/Users")).status).toBe(401);
    expect(await actions(w)).toEqual(expect.arrayContaining(["settings.changed", "token.created", "token.revoked"]));
    expect((await api(h, admin, "PUT", "", { enabled: true, ip_allowlist: ["not an ip"] })).status).toBe(400);
  });

  it("refuses a non-admin who tries to enable SCIM, issue tokens, or see status", async () => {
    const w = await seedScim(pool);
    const h = scimHarness(pool);
    const plain = await session(w, await addPlainMember(pool, w));
    expect((await api(h, plain, "PUT", "", { enabled: false })).status).toBe(403);
    expect((await api(h, plain, "POST", "/tokens", { name: "x" })).status).toBe(403);
    expect((await api(h, plain, "GET", "")).status).toBe(403);
    expect((await api(h, plain, "POST", "/group-roles", { group_id: crypto.randomUUID(), role_id: crypto.randomUUID() })).status).toBe(403);
    const setting = await pool.query("select settings from core.workspace where id = $1", [w.workspaceId]);
    expect(setting.rows[0].settings.scim_enabled).toBe(true);
    expect((await api(h, "", "GET", "")).status).toBe(401);
  });
});

describe("group to role mapping over SCIM", () => {
  it("gives pushed members the role, and Admin only after a different admin confirms", async () => {
    const w = await seedScim(pool);
    const h = scimHarness(pool);
    const second = await addAdmin(pool, w);
    const first = await session(w, w.adminId);
    const other = await session(w, second);
    const user = await h.call(w.token, "POST", "/Users", { schemas: [USER_URN], userName: "m@x.test" });
    const group = await h.call(w.token, "POST", "/Groups", {
      displayName: "Partners",
      members: [{ value: user.body.id }],
    });
    const post = (t: string, path: string, body?: unknown) =>
      h.app.request(`http://api.test/api/v1/admin/scim${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
    const made = await post(first, "/group-roles", { group_id: group.body.id, role_id: w.adminRoleId });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    const role = () => pool.query(`select role_id from core."user" where id = $1`, [user.body.id]);
    expect((await role()).rows[0].role_id).toBeNull();
    expect((await post(first, `/group-roles/${id}/confirm`)).status).toBe(403);
    expect((await role()).rows[0].role_id).toBeNull();
    expect((await post(other, `/group-roles/${id}/confirm`)).status).toBe(204);
    expect((await role()).rows[0].role_id).toBe(w.adminRoleId);
    // Pulling the person out of the group over SCIM takes the role back.
    await h.call(w.token, "PATCH", `/Groups/${group.body.id}`, {
      schemas: [PATCH_URN],
      Operations: [{ op: "remove", path: "members" }],
    });
    expect((await role()).rows[0].role_id).toBeNull();
  });
});
