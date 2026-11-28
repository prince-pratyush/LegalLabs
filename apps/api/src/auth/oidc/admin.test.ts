import { createGateway } from "@legallabs/model-gateway";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSecretBox } from "../../admin-models/secrets.js";
import { createApp } from "../../app.js";
import { createDrafts } from "../../drafts/drafts.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../../test-db.js";
import { type MockIdp, startMockIdp } from "../../test-idp.js";
import { createUsers } from "../../users/users.js";
import { createAuth } from "../auth.js";
import { createSsoAdmin } from "./admin.js";
import { createOidcProviders } from "./providers.js";
import { createOidc } from "./service.js";

const pool = testPool();
const secrets = createSecretBox(Buffer.alloc(32, 3).toString("base64"));
let idp: MockIdp;
let second: MockIdp;

beforeAll(async () => {
  idp = await startMockIdp();
  second = await startMockIdp();
});
afterAll(async () => {
  await idp.close();
  await second.close();
  await pool.end();
});

function harness(opts: { insecureDev?: boolean; secrets?: boolean } = {}) {
  const policy = { insecureDev: opts.insecureDev ?? true };
  const box = opts.secrets === false ? {} : { secrets };
  const documents = testDocuments(pool);
  const providers = createOidcProviders(pool, { ...policy, ...box });
  const app = createApp({
    auth: createAuth(pool),
    oidc: createOidc(pool, { baseUrl: "https://app.test", policy, ...box }),
    sso: createSsoAdmin(pool, { providers, baseUrl: "https://app.test/", policy, ...box }),
    users: createUsers(pool, { baseUrl: "https://app.test" }),
    documents,
    threads: testThreads(pool, documents),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
    }),
    clientIp: () => "203.0.113.9",
  });
  const login = async (m: Seeded, email = m.email) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email, password: PASSWORD }),
    });
    return /__Host-sid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
  };
  const as = async (m: Seeded, email = m.email) => {
    const sid = await login(m, email);
    expect(sid).not.toBe("");
    return async (method: string, body?: unknown) => {
      const res = await app.request("/api/v1/admin/identity/sso", {
        method,
        headers: {
          cookie: `__Host-sid=${sid}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // biome-ignore lint/suspicious/noExplicitAny: tests read many shapes
      return { status: res.status, body: (await res.json()) as any };
    };
  };
  const signIn = async (m: Seeded, claims: Record<string, unknown>, from = idp) => {
    const start = await app.request(`/auth/oidc/start?workspace=${m.slug}`);
    expect(start.status).toBe(302);
    const location = start.headers.get("location") ?? "";
    const state = new URL(location).searchParams.get("state") ?? "";
    const code = from.authorize(location, claims);
    const cookie = /__Host-oidc=([^;]+)/.exec(start.headers.get("set-cookie") ?? "")?.[1];
    const q = new URLSearchParams({ code, state, iss: from.issuer });
    return app.request(`/auth/oidc/callback?${q}`, {
      headers: { cookie: `__Host-oidc=${cookie}` },
    });
  };
  /** Any other admin call, with a session made by password sign-in. */
  const call = async (sid: string, method: string, path: string) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie: `__Host-sid=${sid}` },
    });
    // biome-ignore lint/suspicious/noExplicitAny: tests read many shapes
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const alive = async (sid: string) =>
    (await app.request("/auth/session", { headers: { cookie: `__Host-sid=${sid}` } })).status ===
    200;
  return { app, as, login, signIn, call, alive };
}

const config = (over: object = {}) => ({
  issuer: idp.issuer,
  client_id: idp.clientId,
  client_secret: idp.clientSecret,
  enabled: true,
  ...over,
});

async function person(m: Seeded, name: string, permissions: string[], status = "active") {
  const role = await pool.query<{ id: string }>(
    `insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id`,
    [m.workspaceId, `role-${name}`, permissions],
  );
  const email = `${name}@${m.slug}.test`;
  const user = await pool.query<{ id: string }>(
    `insert into core."user" (workspace_id, email, role_id, status) values ($1, $2, $3, $4)
     returning id`,
    [m.workspaceId, email, role.rows[0]?.id, status],
  );
  const id = user.rows[0]?.id ?? "";
  await pool.query(
    `insert into core.password_credential (workspace_id, user_id, password_hash)
     select $1, $2, password_hash from core.password_credential where user_id = $3`,
    [m.workspaceId, id, m.userId],
  );
  return { id, email };
}

const stored = async (m: Seeded) =>
  (
    await pool.query<{ client_secret: string }>(
      "select client_secret from core.oidc_provider_secret where workspace_id = $1",
      [m.workspaceId],
    )
  ).rows[0]?.client_secret;

describe("configuring single sign-on", () => {
  it("saves a provider, seals the secret and never returns it", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const api = await h.as(m);
    expect((await api("GET")).body).toMatchObject({
      configured: false,
      redirect_uri: "https://app.test/auth/oidc/callback",
      secret_storage: true,
    });
    const saved = await api("PUT", config());
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      configured: true,
      issuer: idp.issuer,
      enabled: true,
      has_secret: true,
      // SEC-006: nothing is matched by email unless an administrator asks.
      link_by_email: false,
    });
    expect(JSON.stringify((await api("GET")).body)).not.toContain(idp.clientSecret);
    expect(await stored(m)).toMatch(/^sealed:v1:/);
    expect(await stored(m)).not.toContain(idp.clientSecret);
    const events = await auditTrail(pool, m.workspaceId);
    expect(events.map((e) => e.action)).toContain("sso.provider_configured");
    expect(JSON.stringify(events)).not.toContain(idp.clientSecret);
  });

  it("signs a person in through the saved provider, with the sealed secret", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const api = await h.as(m);
    await api("PUT", config({ link_by_email: true }));
    const bo = await person(m, "bo", ["threads.use"], "invited");
    const res = await h.signIn(m, { sub: "s-1", email: bo.email, email_verified: true });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toMatch(/__Host-sid=/);
  });

  it("matches nobody by email by default", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const api = await h.as(m);
    await api("PUT", config());
    const bo = await person(m, "bo", ["threads.use"], "invited");
    const res = await h.signIn(m, { sub: "s-1", email: bo.email, email_verified: true });
    expect(res.status).toBe(401);
  });

  it("never lets a second provider into an account by its email", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const api = await h.as(m);
    await api("PUT", config({ link_by_email: true }));
    const bo = await person(m, "bo", ["threads.use"], "invited");
    await h.signIn(m, { sub: "s-1", email: bo.email, email_verified: true });
    await api(
      "PUT",
      config({
        issuer: second.issuer,
        client_id: second.clientId,
        client_secret: second.clientSecret,
        link_by_email: true,
      }),
    );
    const res = await h.signIn(m, { sub: "x-9", email: bo.email, email_verified: true }, second);
    expect(res.status).toBe(401);
    const links = await pool.query("select issuer from core.external_identity where user_id = $1", [
      bo.id,
    ]);
    expect(links.rows).toEqual([{ issuer: idp.issuer }]);
  });

  it("keeps the secret when it is left out, but not across a new issuer", async () => {
    const m = await seedMember(pool);
    const api = await harness().as(m);
    await api("PUT", config());
    const before = await stored(m);
    const { client_secret: _, ...rest } = config({ enabled: false });
    expect((await api("PUT", rest)).status).toBe(200);
    expect(await stored(m)).toBe(before);
    const moved = await api("PUT", { ...rest, issuer: second.issuer });
    expect(moved).toMatchObject({ status: 422, body: { code: "SECRET_REQUIRED" } });
    expect((await api("GET")).body.issuer).toBe(idp.issuer);
    const cleared = await api("PUT", { ...rest, client_secret: null });
    expect(cleared.body.has_secret).toBe(false);
  });

  it("will not fetch a private or unencrypted address in production", async () => {
    const m = await seedMember(pool);
    const api = await harness({ insecureDev: false }).as(m);
    const hits = idp.hits.discovery;
    for (const issuer of [
      idp.issuer,
      "https://127.0.0.1",
      "https://169.254.169.254/latest",
      "https://[::1]",
    ]) {
      const res = await api("PUT", config({ issuer }));
      expect(res.status).toBe(422);
      expect(["INVALID_ISSUER", "DISCOVERY_FAILED"]).toContain(res.body.code);
      // The answer says nothing about what, if anything, was at the address.
      expect(res.body.message).not.toMatch(/ECONN|HTTP \d|address is not allowed/);
    }
    expect(idp.hits.discovery).toBe(hits);
    expect(await stored(m)).toBeUndefined();
  });

  it("refuses to turn on a provider whose discovery does not answer for itself", async () => {
    const m = await seedMember(pool);
    const api = await harness().as(m);
    const res = await api("PUT", config({ issuer: `${idp.issuer}/nowhere` }));
    expect(res).toMatchObject({ status: 422, body: { code: "DISCOVERY_FAILED" } });
    // Turning it off must work while the provider is down.
    expect(
      (await api("PUT", config({ issuer: `${idp.issuer}/nowhere`, enabled: false }))).status,
    ).toBe(200);
  });

  it("says when this installation can't store a secret", async () => {
    const m = await seedMember(pool);
    const api = await harness({ secrets: false }).as(m);
    expect((await api("GET")).body.secret_storage).toBe(false);
    expect(await api("PUT", config())).toMatchObject({
      status: 503,
      body: { code: "KEY_STORAGE_UNAVAILABLE" },
    });
    expect(await stored(m)).toBeUndefined();
  });

  it("is for full administrators to change, since it decides who anyone can be", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const conf = await person(m, "conf", ["admin.config", "admin.users"]);
    const plain = await person(m, "plain", ["threads.use"]);
    const configurer = await h.as(m, conf.email);
    expect((await configurer("GET")).body).toMatchObject({ can_change: false });
    expect(await configurer("PUT", config())).toMatchObject({ status: 403 });
    const nobody = await h.as(m, plain.email);
    expect((await nobody("GET")).status).toBe(403);
    expect((await nobody("PUT", config())).status).toBe(403);
    expect(await stored(m)).toBeUndefined();
  });

  it("shows and changes only the caller's workspace", async () => {
    const one = await seedMember(pool);
    const other = await seedMember(pool);
    const h = harness();
    await (await h.as(one))("PUT", config());
    expect((await (await h.as(other))("GET")).body.configured).toBe(false);
  });

  it("limits how often it may be tried", async () => {
    const m = await seedMember(pool);
    const api = await harness().as(m);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await api("PUT", config({ enabled: false }))).status;
    expect(last).toBe(429);
  });
});

describe("not locking people out", () => {
  const movedConfig = () =>
    config({
      issuer: second.issuer,
      client_id: second.clientId,
      client_secret: second.clientSecret,
    });
  const dropPassword = (userId: string) =>
    pool.query("delete from core.password_credential where user_id = $1", [userId]);

  it("needs a full administrator with a password before turning on or moving", async () => {
    const m = await seedMember(pool);
    const api = await harness().as(m);
    // Someone who isn't a full administrator having a password is no way back in.
    await person(m, "bo", ["admin.config", "admin.users"]);
    await dropPassword(m.userId);
    const refusal = { status: 409, body: { code: "NO_ADMIN_PASSWORD" } };
    expect(await api("PUT", config())).toMatchObject(refusal);
    expect((await api("GET")).body.configured).toBe(false);
    expect(await stored(m)).toBeUndefined();
    // Saving it switched off locks nobody out.
    expect((await api("PUT", config({ enabled: false }))).status).toBe(200);
    expect(await api("PUT", config())).toMatchObject(refusal);
  });

  it("does not move to another issuer without one either", async () => {
    const m = await seedMember(pool);
    const api = await harness().as(m);
    await api("PUT", config());
    await dropPassword(m.userId);
    // Nothing about who can get in changes, so this is fine.
    expect((await api("PUT", config({ require_mfa_claim: true }))).status).toBe(200);
    expect(await api("PUT", movedConfig())).toMatchObject({
      status: 409,
      body: { code: "NO_ADMIN_PASSWORD" },
    });
    expect((await api("GET")).body.issuer).toBe(idp.issuer);
  });

  it("signs out everyone but full administrators when it turns on or moves", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const api = await h.as(m);
    const bo = await person(m, "bo", ["admin.config", "admin.users"]);
    const admin = await h.login(m);
    let theirs = await h.login(m, bo.email);
    expect(await h.alive(theirs)).toBe(true);
    await api("PUT", config());
    expect(await h.alive(theirs)).toBe(false);
    expect(await h.alive(admin)).toBe(true);

    // A session made afterwards survives an unrelated save, and not a move to a new issuer.
    await pool.query(
      `insert into core.session (workspace_id, user_id, token_hash, expires_at)
       values ($1, $2, sha256('later-session'::bytea), now() + interval '1 hour')`,
      [m.workspaceId, bo.id],
    );
    theirs = "later-session";
    await api("PUT", config({ require_mfa_claim: true }));
    expect(await h.alive(theirs)).toBe(true);
    await api("PUT", movedConfig());
    expect(await h.alive(theirs)).toBe(false);
    expect(await h.alive(admin)).toBe(true);
    const events = await auditTrail(pool, m.workspaceId);
    expect(events.map((e) => e.action)).toContain("session.revoked");
  });

  it("lets a full administrator unlink someone, who can then link again", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const api = await h.as(m);
    await api("PUT", config({ link_by_email: true }));
    const bo = await person(m, "bo", ["threads.use"], "invited");
    const claims = { email: bo.email, email_verified: true };
    await h.signIn(m, { sub: "s-1", ...claims });
    await api("PUT", { ...movedConfig(), link_by_email: true });
    expect((await h.signIn(m, { sub: "x-9", ...claims }, second)).status).toBe(401);

    const lesser = await person(m, "lesser", ["admin.users", "admin.config"]);
    await pool.query("update core.oidc_provider set enabled = false where workspace_id = $1", [
      m.workspaceId,
    ]);
    const theirs = await h.login(m, lesser.email);
    const admin = await h.login(m);
    const path = `/admin/users/${bo.id.toUpperCase()}/identities`;
    expect(await h.call(theirs, "DELETE", path)).toMatchObject({ status: 403 });
    const other = await seedMember(pool);
    expect(await h.call(admin, "DELETE", `/admin/users/${other.userId}/identities`)).toMatchObject({
      status: 404,
    });
    const listed = await h.call(admin, "GET", "/admin/users");
    expect(listed.body.items.find((u: { id: string }) => u.id === bo.id).sso_linked).toBe(true);

    expect(await h.call(admin, "DELETE", path)).toMatchObject({
      status: 200,
      body: { sso_linked: false },
    });
    await pool.query("update core.oidc_provider set enabled = true where workspace_id = $1", [
      m.workspaceId,
    ]);
    expect((await h.signIn(m, { sub: "x-9", ...claims }, second)).status).toBe(302);
    const events = await auditTrail(pool, m.workspaceId);
    expect(events.map((e) => e.action)).toContain("sso.identity_unlinked");
  });
});

describe("the browser's way in", () => {
  it("brings a person back to the sign-in screen when it can't start or finish", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const browser = { headers: { accept: "text/html,application/xhtml+xml" } };
    const off = await h.app.request(`/auth/oidc/start?workspace=${m.slug}`, browser);
    expect(off.status).toBe(302);
    expect(off.headers.get("location")).toBe("/#/auth/sso?error=unavailable");
    const failed = await h.app.request("/auth/oidc/callback?code=a&state=b", browser);
    expect(failed.headers.get("location")).toBe("/#/auth/sso?error=failed");
  });
});
