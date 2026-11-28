import { createGateway } from "@legallabs/model-gateway";
import type pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { createMfa, type Mfa } from "../auth/mfa/service.js";
import { createDrafts } from "../drafts/drafts.js";
import { createFakeEmailProvider, type EmailProvider } from "../notifications/email-port.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { createUsers } from "./users.js";

const pool = testPool();
afterAll(() => pool.end());

const NEW_PASSWORD = "a fresh long password";

function harness(opts: { mail?: EmailProvider; mfa?: Mfa; now?: () => number } = {}) {
  const documents = testDocuments(pool);
  const app = createApp({
    auth: createAuth(pool),
    users: createUsers(pool, {
      baseUrl: "https://app.test/",
      ...(opts.mail ? { mail: opts.mail } : {}),
    }),
    ...(opts.mfa ? { mfa: opts.mfa } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    documents,
    threads: testThreads(pool, documents),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
    }),
    clientIp: () => "203.0.113.9",
  });
  const post = (path: string, body: unknown, cookie = "") =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const login = async (workspace: string, email: string, password: string) => {
    const res = await post("/auth/login", { workspace, email, password });
    const sid = /__Host-sid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    return { status: res.status, cookie: sid ? `__Host-sid=${sid}` : "", res };
  };
  const as = async (who: { slug: string; email: string }, password = PASSWORD) => {
    const { cookie } = await login(who.slug, who.email, password);
    expect(cookie).not.toBe("");
    return async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api/v1${path}`, {
        method,
        headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      // biome-ignore lint/suspicious/noExplicitAny: tests read many shapes
      return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
    };
  };
  return { app, post, login, as };
}

type Api = Awaited<ReturnType<ReturnType<typeof harness>["as"]>>;

const roleId = async (api: Api, name: string) =>
  (await api("GET", "/admin/roles")).body.items.find((r: { name: string }) => r.name === name)
    ?.id as string;

const tokenIn = (link: string) => new URLSearchParams(link.split("?")[1] ?? "").get("token") ?? "";

async function inviteOne(api: Api, email: string, role = "User") {
  const res = await api("POST", "/admin/users/invite", {
    emails: [email],
    role_id: await roleId(api, role),
  });
  expect(res.status).toBe(200);
  return res.body.invited[0] as { id: string; delivery: string; link?: string };
}

/** Another member with a password, holding the given permissions through a custom role. */
async function member(m: Seeded, name: string, permissions: string[]) {
  const role = await pool.query<{ id: string }>(
    `insert into core.role (workspace_id, name, permissions) values ($1, $2, $3)
     on conflict (workspace_id, name) do update set name = excluded.name returning id`,
    [m.workspaceId, `role-${name}`, permissions],
  );
  const email = `${name}@${m.slug}.test`;
  const user = await pool.query<{ id: string }>(
    `insert into core."user" (workspace_id, email, role_id, status) values ($1, $2, $3, 'active')
     returning id`,
    [m.workspaceId, email, role.rows[0]?.id],
  );
  const id = user.rows[0]?.id ?? "";
  await pool.query(
    `insert into core.password_credential (workspace_id, user_id, password_hash)
     select $1, $2, password_hash from core.password_credential where user_id = $3`,
    [m.workspaceId, id, m.userId],
  );
  return { id, slug: m.slug, email, roleId: role.rows[0]?.id ?? "" };
}

const statusOf = async (db: pg.Pool, id: string) =>
  (await db.query(`select status from core."user" where id = $1`, [id])).rows[0]?.status;
const actions = async (m: Seeded) => (await auditTrail(pool, m.workspaceId)).map((r) => r.action);

describe("roles", () => {
  it("offers the built-in User role with the default permissions and no admin rights", async () => {
    const m = await seedMember(pool);
    const api = await harness().as(m);
    const res = await api("GET", "/admin/roles");
    const user = res.body.items.find((r: { name: string }) => r.name === "User");
    expect(user).toMatchObject({ builtin: true, admin: false });
    expect(user.permissions).toContain("threads.use");
    expect(user.permissions.filter((p: string) => p.startsWith("admin."))).toEqual([]);
  });

  it("holds custom roles to five, and to permissions the maker holds", async () => {
    const m = await seedMember(pool);
    // Admin is one custom role already in this seed (builtin false), so it is marked built in.
    await pool.query("update core.role set builtin = true where workspace_id = $1", [
      m.workspaceId,
    ]);
    const h = harness();
    const api = await h.as(m);
    for (let i = 0; i < 5; i++) {
      const made = await api("POST", "/admin/roles", {
        name: `Custom ${i}`,
        permissions: ["threads.use"],
      });
      expect(made.status).toBe(201);
    }
    const sixth = await api("POST", "/admin/roles", { name: "Sixth", permissions: [] });
    expect(sixth).toMatchObject({ status: 422, body: { code: "ROLE_LIMIT" } });
    expect((await api("POST", "/admin/roles", { name: "All", permissions: ["*"] })).status).toBe(
      400,
    );

    const other = await seedMember(pool);
    const manager = await member(other, "manager", ["admin.users", "threads.use"]);
    const limited = await h.as(manager);
    const grab = await limited("POST", "/admin/roles", {
      name: "Grab",
      permissions: ["admin.audit"],
    });
    expect(grab.status).toBe(403);
  });
});

describe("inviting", () => {
  it("shows the link once when there is no mail server; it sets a password, once", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const api = await h.as(m);
    const email = `bo@${m.slug}.test`;
    const invite = await inviteOne(api, email);
    expect(invite.delivery).toBe("link");
    expect(invite.link).toMatch(/^https:\/\/app\.test\/#\/auth\/invite\?token=/);
    const token = tokenIn(invite.link ?? "");
    // Only the hash is stored, and the link is in no audit event.
    const stored = await pool.query("select token_hash from core.user_invite where user_id = $1", [
      invite.id,
    ]);
    expect(stored.rows[0].token_hash.toString("base64url")).not.toBe(token);
    expect(JSON.stringify(await auditTrail(pool, m.workspaceId))).not.toContain(token);
    const listed = await api("GET", "/admin/users");
    expect(JSON.stringify(listed.body)).not.toContain(token);
    expect(listed.body.items.find((u: { id: string }) => u.id === invite.id).status).toBe(
      "invited",
    );
    expect((await h.login(m.slug, email, NEW_PASSWORD)).status).toBe(401);

    const accepted = await h.post("/auth/invite/accept", { token, password: NEW_PASSWORD });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ workspace: m.slug, email });
    // Accepting signs nobody in: sign-in, and any second factor, comes next.
    expect(accepted.headers.get("set-cookie")).toBeNull();
    expect((await h.login(m.slug, email, NEW_PASSWORD)).status).toBe(200);

    const again = await h.post("/auth/invite/accept", { token, password: "another password!!" });
    expect(again.status).toBe(400);
    expect((await h.login(m.slug, email, NEW_PASSWORD)).status).toBe(200);
    expect(await actions(m)).toEqual(
      expect.arrayContaining(["user.invited", "user.invite_batch", "user.invite_accepted"]),
    );
  });

  it("answers every bad link alike", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const api = await h.as(m);
    const invite = await inviteOne(api, `cy@${m.slug}.test`);
    await pool.query(
      "update core.user_invite set expires_at = now() - interval '1 second' where user_id = $1",
      [invite.id],
    );
    const expired = await h.post("/auth/invite/accept", {
      token: tokenIn(invite.link ?? ""),
      password: NEW_PASSWORD,
    });
    const unknown = await h.post("/auth/invite/accept", {
      token: "x".repeat(43),
      password: NEW_PASSWORD,
    });
    expect([expired.status, unknown.status]).toEqual([400, 400]);
    expect(await expired.json()).toEqual(await unknown.json());
    expect(
      (await h.post("/auth/invite/accept", { token: "x".repeat(43), password: "short" })).status,
    ).toBe(400);
  });

  it("limits how often one address may try a link", async () => {
    const h = harness();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (
        await h.post("/auth/invite/accept", { token: "y".repeat(43), password: NEW_PASSWORD })
      ).status;
    }
    expect(last).toBe(429);
  });

  it("emails the link and keeps it from the administrator", async () => {
    const m = await seedMember(pool);
    const mail = createFakeEmailProvider();
    const h = harness({ mail });
    const api = await h.as(m);
    const invite = await inviteOne(api, `di@${m.slug}.test`);
    expect(invite).toMatchObject({ delivery: "email" });
    expect(invite.link).toBeUndefined();
    expect(mail.sent).toHaveLength(1);
    const link = /https:\/\/app\.test\/\S+/.exec(mail.sent[0]?.text ?? "")?.[0] ?? "";
    expect(
      (await h.post("/auth/invite/accept", { token: tokenIn(link), password: NEW_PASSWORD }))
        .status,
    ).toBe(200);

    mail.failNext();
    const lost = await inviteOne(api, `ed@${m.slug}.test`);
    expect(lost).toMatchObject({ delivery: "failed" });
    expect(lost.link).toBeUndefined();
  });

  it("sends a fresh link on request and retires the old one", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const api = await h.as(m);
    const first = await inviteOne(api, `fi@${m.slug}.test`);
    const second = await api("POST", `/admin/users/${first.id}/invite`);
    expect(second.status).toBe(200);
    const old = await h.post("/auth/invite/accept", {
      token: tokenIn(first.link ?? ""),
      password: NEW_PASSWORD,
    });
    expect(old.status).toBe(400);
    const fresh = await h.post("/auth/invite/accept", {
      token: tokenIn(second.body.link),
      password: NEW_PASSWORD,
    });
    expect(fresh.status).toBe(200);
    // Once they have joined there is nothing to resend: no link may reset a live password.
    expect((await api("POST", `/admin/users/${first.id}/invite`)).status).toBe(409);
  });

  it("skips and reports people already there, repeats and bad addresses", async () => {
    const m = await seedMember(pool);
    const api = await harness().as(m);
    const res = await api("POST", "/admin/users/invite", {
      emails: [m.email.toUpperCase(), `gu@${m.slug}.test`, `GU@${m.slug}.test`, "not an email"],
      role_id: await roleId(api, "User"),
    });
    expect(res.body.invited).toHaveLength(1);
    expect(res.body.skipped.map((s: { reason: string }) => s.reason)).toEqual([
      "exists",
      "duplicate",
      "invalid",
    ]);
    const many = Array.from({ length: 101 }, (_, i) => `p${i}@${m.slug}.test`);
    const over = await api("POST", "/admin/users/invite", {
      emails: many,
      role_id: await roleId(api, "User"),
    });
    expect(over).toMatchObject({ status: 422, body: { code: "INVITE_LIMIT" } });
  });

  it("never invites an administrator, or into a role above the inviter", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const api = await h.as(m);
    const admin = await api("POST", "/admin/users/invite", {
      emails: [`hi@${m.slug}.test`],
      role_id: await roleId(api, "Admin"),
    });
    expect(admin).toMatchObject({ status: 422, body: { code: "ADMIN_ROLE" } });

    const manager = await member(m, "manager", ["admin.users", "threads.use"]);
    const rich = await member(m, "rich", ["agents.build"]);
    const limited = await h.as(manager);
    const above = await limited("POST", "/admin/users/invite", {
      emails: [`io@${m.slug}.test`],
      role_id: rich.roleId,
    });
    expect(above.status).toBe(403);
    const none = await pool.query(
      `select 1 from core."user" where email like 'io@%' and workspace_id = $1`,
      [m.workspaceId],
    );
    expect(none.rowCount).toBe(0);
  });

  it("is closed to people without admin.users, and while an identity provider manages users", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const plain = await member(m, "plain", ["threads.use"]);
    const nobody = await h.as(plain);
    expect((await nobody("GET", "/admin/users")).status).toBe(403);
    expect(
      (
        await nobody("POST", "/admin/users/invite", {
          emails: [`jo@${m.slug}.test`],
          role_id: plain.roleId,
        })
      ).status,
    ).toBe(403);
    expect((await nobody("POST", "/admin/groups", { name: "G" })).status).toBe(403);

    const api = await h.as(m);
    await pool.query(
      `update core.workspace set settings = settings || '{"scim_enabled": true}' where id = $1`,
      [m.workspaceId],
    );
    const res = await api("POST", "/admin/users/invite", {
      emails: [`jo@${m.slug}.test`],
      role_id: await roleId(api, "User"),
    });
    expect(res).toMatchObject({ status: 409, body: { code: "SCIM_ENABLED" } });
  });

  it("still asks an invited person for the second factor the policy demands", async () => {
    const m = await seedMember(pool);
    await pool.query(
      `update core.workspace set settings = settings || '{"mfa": "all"}' where id = $1`,
      [m.workspaceId],
    );
    const mfa = createMfa(pool, {
      rpID: "app.test",
      rpName: "test",
      origins: ["https://app.test"],
      encryptionKey: Buffer.alloc(32, 7),
    });
    // The seeded admin is also covered by the policy, so act through the service directly.
    const users = createUsers(pool, { baseUrl: "https://app.test" });
    const who = { userId: m.userId, workspaceId: m.workspaceId, sessionId: "" };
    const client = { ip: null, userAgent: null };
    const roles = await users.roles(who);
    const result = await users.invite(
      who,
      { emails: [`ku@${m.slug}.test`], role_id: roles.find((r) => r.name === "User")?.id ?? "" },
      client,
    );
    const h = harness({ mfa });
    const token = tokenIn(result.invited[0]?.link ?? "");
    expect((await h.post("/auth/invite/accept", { token, password: NEW_PASSWORD })).status).toBe(
      200,
    );
    const signIn = await h.login(m.slug, `ku@${m.slug}.test`, NEW_PASSWORD);
    expect(signIn.cookie).toBe("");
    expect(await signIn.res.json()).toMatchObject({ mfa_enrolment_required: true });
  });
});

describe("changing people", () => {
  it("ends sessions on suspension and lets them back on reactivation", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const api = await h.as(m);
    const bo = await member(m, "bo", ["threads.use"]);
    const theirs = await h.login(m.slug, bo.email, PASSWORD);
    const check = async () =>
      (await h.app.request("/auth/session", { headers: { cookie: theirs.cookie } })).status;
    expect(await check()).toBe(200);

    expect((await api("PATCH", `/admin/users/${bo.id}`, { status: "suspended" })).status).toBe(200);
    expect(await check()).toBe(401);
    expect((await h.login(m.slug, bo.email, PASSWORD)).status).toBe(401);

    expect((await api("PATCH", `/admin/users/${bo.id}`, { status: "active" })).status).toBe(200);
    expect(await statusOf(pool, bo.id)).toBe("active");
    // The old session stays dead.
    expect(await check()).toBe(401);
    expect((await h.login(m.slug, bo.email, PASSWORD)).status).toBe(200);
    expect(await actions(m)).toEqual(
      expect.arrayContaining(["user.suspended", "user.reactivated", "session.revoked"]),
    );
  });

  it("returns someone who never joined to invited, with their link dead", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const api = await h.as(m);
    const invite = await inviteOne(api, `cy@${m.slug}.test`);
    await api("PATCH", `/admin/users/${invite.id}`, { status: "suspended" });
    await api("PATCH", `/admin/users/${invite.id}`, { status: "active" });
    expect(await statusOf(pool, invite.id)).toBe("invited");
    const res = await h.post("/auth/invite/accept", {
      token: tokenIn(invite.link ?? ""),
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(400);
  });

  it("ends sessions when the role changes, and records it", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const api = await h.as(m);
    const bo = await member(m, "bo", ["threads.use"]);
    const theirs = await h.login(m.slug, bo.email, PASSWORD);
    const res = await api("PATCH", `/admin/users/${bo.id}`, {
      role_id: await roleId(api, "User"),
    });
    expect(res.status).toBe(200);
    expect(
      (await h.app.request("/auth/session", { headers: { cookie: theirs.cookie } })).status,
    ).toBe(401);
    const updated = (await auditTrail(pool, m.workspaceId)).find(
      (r) => r.action === "user.updated",
    );
    expect(updated?.details).toMatchObject({ fields: ["role_id"] });
  });

  it("will not make an administrator of someone who has not joined", async () => {
    const m = await seedMember(pool);
    const api = await harness().as(m);
    const invite = await inviteOne(api, `di@${m.slug}.test`);
    const res = await api("PATCH", `/admin/users/${invite.id}`, {
      role_id: await roleId(api, "Admin"),
    });
    expect(res).toMatchObject({ status: 409, body: { code: "NOT_JOINED" } });
  });

  it("cannot be used to climb or to push others down", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const owner = await h.as(m);
    const manager = await member(m, "manager", ["admin.users", "threads.use"]);
    const plain = await member(m, "plain", ["threads.use"]);
    const limited = await h.as(manager);
    const adminRole = await roleId(owner, "Admin");

    // Granting what they lack, to someone else or themselves.
    expect(
      (await limited("PATCH", `/admin/users/${plain.id}`, { role_id: adminRole })).status,
    ).toBe(403);
    expect(
      await limited("PATCH", `/admin/users/${manager.id}`, { role_id: adminRole }),
    ).toMatchObject({ status: 409, body: { code: "OWN_ACCOUNT" } });
    // Touching someone who holds more than they do, in any way.
    expect(
      (await limited("PATCH", `/admin/users/${m.userId}`, { status: "suspended" })).status,
    ).toBe(403);
    expect(
      (await limited("PATCH", `/admin/users/${m.userId}`, { role_id: plain.roleId })).status,
    ).toBe(403);
    const group = await owner("POST", "/admin/groups", { name: "Deal team" });
    expect(
      (await limited("PATCH", `/admin/users/${m.userId}`, { group_ids: [group.body.id] })).status,
    ).toBe(403);
    expect(await statusOf(pool, m.userId)).toBe("active");
    expect(
      (await limited("PATCH", `/admin/users/${plain.id}`, { status: "suspended" })).status,
    ).toBe(200);
  });

  it("keeps the last administrator", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const api = await h.as(m);
    const self = await api("PATCH", `/admin/users/${m.userId}`, { status: "suspended" });
    expect(self).toMatchObject({ status: 409, body: { code: "OWN_ACCOUNT" } });

    // Two administrators removing each other at the same moment: one must lose.
    const second = await member(m, "second", ["threads.use"]);
    const adminRole = await roleId(api, "Admin");
    expect((await api("PATCH", `/admin/users/${second.id}`, { role_id: adminRole })).status).toBe(
      200,
    );
    const other = await h.as(second);
    const both = await Promise.all([
      api("PATCH", `/admin/users/${second.id}`, { status: "suspended" }),
      other("PATCH", `/admin/users/${m.userId}`, { status: "suspended" }),
    ]);
    const left = await pool.query(
      `select count(*)::int as n from core."user" u
         join core.role r on r.id = u.role_id
        where u.workspace_id = $1 and u.status = 'active' and '*' = any (r.permissions)`,
      [m.workspaceId],
    );
    expect(left.rows[0].n).toBeGreaterThanOrEqual(1);
    expect(both.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
  });

  it("leaves service accounts, guests and SCIM-managed people alone", async () => {
    const m = await seedMember(pool);
    const api = await harness().as(m);
    const service = await pool.query<{ id: string }>(
      `insert into core."user" (workspace_id, email, kind, status)
       values ($1, 'svc@scim.invalid', 'service', 'active') returning id`,
      [m.workspaceId],
    );
    expect(
      (await api("PATCH", `/admin/users/${service.rows[0]?.id}`, { status: "suspended" })).status,
    ).toBe(404);
    const listed = await api("GET", "/admin/users");
    expect(listed.body.items.map((u: { email: string }) => u.email)).not.toContain(
      "svc@scim.invalid",
    );

    const bo = await member(m, "bo", ["threads.use"]);
    await pool.query(`update core."user" set scim_managed = true where id = $1`, [bo.id]);
    expect(await api("PATCH", `/admin/users/${bo.id}`, { status: "suspended" })).toMatchObject({
      status: 409,
      body: { code: "SCIM_MANAGED" },
    });
    expect(await statusOf(pool, bo.id)).toBe("active");
  });

  it("answers for another workspace's people as for nobody", async () => {
    const m = await seedMember(pool);
    const other = await seedMember(pool);
    const api = await harness().as(m);
    const there = await api("PATCH", `/admin/users/${other.userId}`, { status: "suspended" });
    const nobody = await api("PATCH", "/admin/users/0190a000-0000-7000-8000-000000000000", {
      status: "suspended",
    });
    expect(there).toEqual(nobody);
    expect(there.status).toBe(404);
    expect((await api("POST", `/admin/users/${other.userId}/invite`)).status).toBe(404);
    const theirRole = await pool.query("select id from core.role where workspace_id = $1", [
      other.workspaceId,
    ]);
    const res = await api("POST", "/admin/users/invite", {
      emails: [`zz@${m.slug}.test`],
      role_id: theirRole.rows[0].id,
    });
    expect(res.status).toBe(404);
    expect(await statusOf(pool, other.userId)).toBe("active");
  });

  it("sets group membership, leaving an identity provider's groups alone", async () => {
    const m = await seedMember(pool);
    const api = await harness().as(m);
    const bo = await member(m, "bo", ["threads.use"]);
    const synced = await pool.query<{ id: string }>(
      `insert into core."group" (workspace_id, name, scim_group_id) values ($1, 'IdP', 'x')
       returning id`,
      [m.workspaceId],
    );
    await pool.query(
      "insert into core.group_member (workspace_id, group_id, user_id) values ($1, $2, $3)",
      [m.workspaceId, synced.rows[0]?.id, bo.id],
    );
    const deal = await api("POST", "/admin/groups", { name: "Deal team" });
    expect(deal.status).toBe(201);
    expect((await api("POST", "/admin/groups", { name: "Deal team" })).status).toBe(409);
    expect(
      (await api("PATCH", `/admin/users/${bo.id}`, { group_ids: [deal.body.id] })).status,
    ).toBe(200);
    const row = (await api("GET", "/admin/users")).body.items.find(
      (u: { id: string }) => u.id === bo.id,
    );
    expect(row.group_ids.sort()).toEqual([deal.body.id, synced.rows[0]?.id].sort());
    expect(
      (await api("PATCH", `/admin/users/${bo.id}`, { group_ids: [synced.rows[0]?.id] })).status,
    ).toBe(404);
    await api("PATCH", `/admin/users/${bo.id}`, { group_ids: [] });
    const left = await pool.query("select group_id from core.group_member where user_id = $1", [
      bo.id,
    ]);
    expect(left.rows).toEqual([{ group_id: synced.rows[0]?.id }]);
    expect(await actions(m)).toEqual(
      expect.arrayContaining(["group.created", "group.members_changed"]),
    );
  });
});
