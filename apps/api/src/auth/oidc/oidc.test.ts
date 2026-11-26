import { randomBytes } from "node:crypto";
import { createGateway } from "@legallabs/model-gateway";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { asApp } from "../../db.js";
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
import { type MockIdp, startMockIdp, type Tweaks } from "../../test-idp.js";
import { createAuth } from "../auth.js";
import { createMfa, type Mfa } from "../mfa/service.js";
import { createOidcProviders, type ProviderInput } from "./providers.js";
import { createOidc } from "./service.js";

const pool = testPool();
const auth = createAuth(pool);
const client = { ip: "203.0.113.9", userAgent: "vitest" };
let idp: MockIdp;

beforeAll(async () => {
  idp = await startMockIdp();
});
afterAll(async () => {
  await idp.close();
  await pool.end();
});

const harness = (mfa?: Mfa) => {
  const oidc = createOidc(pool, {
    baseUrl: "https://app.test",
    policy: { insecureDev: true },
    ...(mfa ? { secondFactor: mfa.secondStep } : {}),
  });
  const app = createApp({
    auth,
    oidc,
    documents: testDocuments(pool),
    threads: testThreads(pool, testDocuments(pool)),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
    }),
    clientIp: () => client.ip,
  });
  return app;
};

const principalOf = (m: Seeded) => ({
  userId: m.userId,
  workspaceId: m.workspaceId,
  sessionId: "",
});
const providers = createOidcProviders(pool, { insecureDev: true });

// A workspace whose admin has configured the mock IdP.
async function workspace(config: Partial<ProviderInput> = {}) {
  const admin = await seedMember(pool);
  await providers.put(
    principalOf(admin),
    { issuer: idp.issuer, clientId: idp.clientId, enabled: true, ...config },
    idp.clientSecret,
    client,
  );
  return admin;
}

// An admin pre-creating a person, as the invite flow does.
async function invite(m: Seeded, email: string, status = "invited") {
  const { rows } = await pool.query<{ id: string }>(
    `insert into core."user" (workspace_id, email, status) values ($1, $2, $3) returning id`,
    [m.workspaceId, email, status],
  );
  return rows[0]?.id ?? "";
}

const cookieOf = (res: Response) =>
  /__Host-oidc=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];

interface Run {
  start: Response;
  callback: Response;
  state: string;
  code: string;
  cookie: string;
}

async function signIn(
  app: ReturnType<typeof harness>,
  m: Seeded,
  claims: Record<string, unknown>,
  tweaks: Tweaks = {},
  override: { state?: string; cookie?: string | null; iss?: string | null } = {},
): Promise<Run> {
  const start = await app.request(`/auth/oidc/start?workspace=${m.slug}`);
  expect(start.status).toBe(302);
  const location = start.headers.get("location") ?? "";
  const state = new URL(location).searchParams.get("state") ?? "";
  const code = idp.authorize(location, claims, tweaks);
  const cookie = cookieOf(start) ?? "";
  const q = new URLSearchParams({ code, state: override.state ?? state });
  if (override.iss !== null) q.set("iss", override.iss ?? idp.issuer);
  const useCookie = override.cookie === undefined ? cookie : override.cookie;
  const callback = await app.request(`/auth/oidc/callback?${q}`, {
    headers: useCookie ? { cookie: `__Host-oidc=${useCookie}` } : {},
  });
  return { start, callback, state, code, cookie };
}

const failures = async (m: Seeded) =>
  (await auditTrail(pool, m.workspaceId)).filter((e) => e.action === "login.failure");

const sidOf = (res: Response) =>
  /__Host-sid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];

describe("starting a sign-in", () => {
  it("sends the browser to the IdP with PKCE S256, state and nonce", async () => {
    const m = await workspace();
    const res = await harness().request(`/auth/oidc/start?workspace=${m.slug}`);
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location") ?? "");
    expect(url.origin + url.pathname).toBe(`${idp.issuer}/authorize`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(idp.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.test/auth/oidc/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("state")?.length).toBeGreaterThan(30);
    expect(url.searchParams.get("nonce")?.length).toBeGreaterThan(30);
    expect(res.headers.get("set-cookie")).toMatch(/__Host-oidc=.*HttpOnly/i);
  });

  it("refuses a workspace with no enabled provider", async () => {
    const m = await seedMember(pool);
    expect((await harness().request(`/auth/oidc/start?workspace=${m.slug}`)).status).toBe(404);
    const off = await workspace({ enabled: false });
    expect((await harness().request(`/auth/oidc/start?workspace=${off.slug}`)).status).toBe(404);
  });
});

describe("signing in", () => {
  it("links the user an admin created, opens a session and records both", async () => {
    const m = await workspace();
    const userId = await invite(m, `bo@${m.slug}.test`);
    const app = harness();
    const run = await signIn(app, m, { email: `Bo@${m.slug}.test`, email_verified: true });
    expect(run.callback.status).toBe(302);
    expect(run.callback.headers.get("location")).toBe("/");

    const token = sidOf(run.callback);
    expect(token).toBeTruthy();
    expect(await auth.resolve(token ?? "")).toMatchObject({ userId, workspaceId: m.workspaceId });

    const { rows } = await pool.query(
      "select issuer, subject, linked_via from core.external_identity where user_id = $1",
      [userId],
    );
    expect(rows).toEqual([{ issuer: idp.issuer, subject: "sub-1", linked_via: "email" }]);
    const status = await pool.query(`select status from core."user" where id = $1`, [userId]);
    expect(status.rows[0].status).toBe("active");

    const actions = (await auditTrail(pool, m.workspaceId)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["sso.identity_linked", "login.success"]));
  });

  it("signs in by subject after the first link, whatever the email says", async () => {
    const m = await workspace();
    const userId = await invite(m, `bo@${m.slug}.test`);
    const app = harness();
    await signIn(app, m, { email: `bo@${m.slug}.test`, email_verified: true });
    const again = await signIn(app, m, { email: "renamed@elsewhere.test", email_verified: false });
    expect(again.callback.status).toBe(302);
    expect(await auth.resolve(sidOf(again.callback) ?? "")).toMatchObject({ userId });
  });

  it("never links a different subject to a linked user just because the email matches", async () => {
    const m = await workspace();
    await invite(m, `bo@${m.slug}.test`);
    const app = harness();
    await signIn(app, m, { sub: "owner", email: `bo@${m.slug}.test`, email_verified: true });
    const intruder = await signIn(app, m, {
      sub: "someone-else",
      email: `bo@${m.slug}.test`,
      email_verified: true,
    });
    expect(intruder.callback.status).toBe(401);
    expect((await failures(m)).at(-1)?.details).toMatchObject({ reason: "identity_conflict" });
  });

  it("does not link on an unverified email", async () => {
    const m = await workspace();
    await invite(m, `bo@${m.slug}.test`);
    const run = await signIn(harness(), m, { email: `bo@${m.slug}.test`, email_verified: "true" });
    expect(run.callback.status).toBe(401);
    expect((await failures(m)).at(-1)?.details).toMatchObject({ reason: "email_unverified" });
  });

  it("does not link by email when the workspace policy forbids it", async () => {
    const m = await workspace({ linkByEmail: false });
    await invite(m, `bo@${m.slug}.test`);
    const run = await signIn(harness(), m, { email: `bo@${m.slug}.test`, email_verified: true });
    expect(run.callback.status).toBe(401);
    expect((await failures(m)).at(-1)?.details).toMatchObject({ reason: "unprovisioned" });
  });

  it.each([false, true])("never creates a user (SCIM on: %s) and audits why", async (scim) => {
    const m = await workspace();
    await pool.query(
      `update core.workspace set settings = jsonb_build_object('scim_enabled', $2::boolean) where id = $1`,
      [m.workspaceId, scim],
    );
    const before = await pool.query(
      `select count(*)::int n from core."user" where workspace_id = $1`,
      [m.workspaceId],
    );
    const run = await signIn(harness(), m, { email: `new@${m.slug}.test`, email_verified: true });
    expect(run.callback.status).toBe(401);
    expect(await run.callback.json()).toEqual({ error: "sso_failed" });
    const after = await pool.query(
      `select count(*)::int n from core."user" where workspace_id = $1`,
      [m.workspaceId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect((await failures(m)).at(-1)).toMatchObject({
      actor_type: "system",
      details: { method: "oidc", reason: "unprovisioned", scim_enabled: scim },
    });
  });

  it.each(["suspended", "deprovisioned"])(
    "turns away a %s user, even one already linked",
    async (status) => {
      const m = await workspace();
      const userId = await invite(m, `bo@${m.slug}.test`, status);
      const first = await signIn(harness(), m, {
        email: `bo@${m.slug}.test`,
        email_verified: true,
      });
      expect(first.callback.status).toBe(401);
      expect((await failures(m)).at(-1)?.details).toMatchObject({ reason: "not_active" });

      // Link while active, then suspend: the identity must not be a way around it.
      await pool.query(`update core."user" set status = 'active' where id = $1`, [userId]);
      const app = harness();
      const ok = await signIn(app, m, { email: `bo@${m.slug}.test`, email_verified: true });
      expect(ok.callback.status).toBe(302);
      await pool.query(`update core."user" set status = $2 where id = $1`, [userId, status]);
      const again = await signIn(app, m, { email: `bo@${m.slug}.test`, email_verified: true });
      expect(again.callback.status).toBe(401);
      expect(await auth.resolve(sidOf(ok.callback) ?? "")).toBeNull();
    },
  );

  it("ignores an off-site return_to", async () => {
    const m = await workspace();
    await invite(m, `bo@${m.slug}.test`);
    const app = harness();
    const start = await app.request(`/auth/oidc/start?workspace=${m.slug}&return_to=//evil.test`);
    const location = start.headers.get("location") ?? "";
    const code = idp.authorize(location, { email: `bo@${m.slug}.test`, email_verified: true });
    const res = await app.request(
      `/auth/oidc/callback?code=${code}&state=${new URL(location).searchParams.get("state")}`,
      { headers: { cookie: `__Host-oidc=${cookieOf(start)}` } },
    );
    expect(res.headers.get("location")).toBe("/");
  });
});

describe("the second factor", () => {
  const login = async (claims: Record<string, unknown>, config: Partial<ProviderInput> = {}) => {
    const m = await workspace(config);
    const userId = await invite(m, `bo@${m.slug}.test`);
    const run = await signIn(harness(), m, {
      email: `bo@${m.slug}.test`,
      email_verified: true,
      ...claims,
    });
    const { rows } = await pool.query(`select mfa_at from core.session where user_id = $1`, [
      userId,
    ]);
    return { m, run, mfaAt: rows[0]?.mfa_at as Date | undefined };
  };

  it.each([["mfa"], ["hwk"], ["otp"], ["swk"]])("stamps mfa_at when amr has %s", async (value) => {
    const { mfaAt } = await login({ amr: ["pwd", value] });
    expect(mfaAt).toBeInstanceOf(Date);
  });

  it("leaves mfa_at empty without an mfa amr, so the workspace policy applies", async () => {
    expect((await login({ amr: ["pwd"] })).mfaAt).toBeNull();
    expect((await login({})).mfaAt).toBeNull();
  });

  it("honours a mapped acr", async () => {
    const { mfaAt } = await login({ acr: "urn:mfa" }, { mfaAcrValues: ["urn:mfa"] });
    expect(mfaAt).toBeInstanceOf(Date);
  });

  it("rejects a sign-in without the claim when the workspace requires it", async () => {
    const { m, run } = await login({ amr: ["pwd"] }, { requireMfaClaim: true });
    expect(run.callback.status).toBe(401);
    expect((await failures(m)).at(-1)?.details).toMatchObject({ reason: "mfa_required" });
  });

  describe("with the app's own policy on", () => {
    const mfa = createMfa(pool, {
      rpID: "legal.test",
      rpName: "LegalLabs",
      origins: ["https://legal.test"],
      encryptionKey: randomBytes(32),
    });
    const go = async (claims: Record<string, unknown>) => {
      const m = await workspace();
      await pool.query(
        `update core.workspace set settings = settings || '{"mfa":"all"}' where id = $1`,
        [m.workspaceId],
      );
      const userId = await invite(m, `cy@${m.slug}.test`);
      const run = await signIn(harness(mfa), m, {
        email: `cy@${m.slug}.test`,
        email_verified: true,
        ...claims,
      });
      const { rowCount } = await pool.query("select 1 from core.session where user_id = $1", [
        userId,
      ]);
      return { run, sessions: rowCount };
    };

    it("asks for a second factor when the IdP asserted none", async () => {
      const { run, sessions } = await go({ amr: ["pwd"] });
      expect(run.callback.status).toBe(302);
      // The pending token stays out of the address bar: only this browser's cookie holds it.
      expect(run.callback.headers.get("location")).toBe(
        "/#/auth/mfa?kind=enrol&methods=totp,passkey",
      );
      expect(run.callback.headers.get("set-cookie")).toMatch(
        /__Host-mfa=[^;]{20,}; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Strict/,
      );
      expect(sidOf(run.callback)).toBeUndefined();
      expect(sessions).toBe(0);
    });

    it("trusts an IdP that asserted MFA", async () => {
      const { run, sessions } = await go({ amr: ["mfa"] });
      expect(run.callback.headers.get("location")).toBe("/");
      expect(sidOf(run.callback)).toBeDefined();
      expect(sessions).toBe(1);
    });

    it("signs in at once where the policy asks nothing", async () => {
      const m = await workspace();
      await invite(m, `di@${m.slug}.test`);
      const run = await signIn(harness(mfa), m, {
        email: `di@${m.slug}.test`,
        email_verified: true,
      });
      expect(sidOf(run.callback)).toBeDefined();
    });
  });

  it("is visible through the session lookup", async () => {
    const { run } = await login({ amr: ["mfa"] });
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256")
      .update(sidOf(run.callback) ?? "")
      .digest();
    const { rows } = await pool.query("select mfa_at from core.resolve_session($1)", [hash]);
    expect(rows[0].mfa_at).toBeInstanceOf(Date);
  });
});

describe("what the IdP must get right", () => {
  const rejected = async (
    tweaks: Tweaks,
    override = {},
    expected: Record<string, unknown> = {},
  ) => {
    const m = await workspace();
    const userId = await invite(m, `bo@${m.slug}.test`);
    const run = await signIn(
      harness(),
      m,
      { email: `bo@${m.slug}.test`, email_verified: true },
      tweaks,
      override,
    );
    expect(run.callback.status).toBe(401);
    const { rows } = await pool.query("select 1 from core.session where user_id = $1", [userId]);
    expect(rows).toHaveLength(0);
    if (Object.keys(expected).length > 0)
      expect((await failures(m)).at(-1)?.details).toMatchObject(expected);
    return m;
  };

  it("rejects the wrong nonce", () =>
    rejected({ nonce: "not-ours" }, {}, { reason: "nonce_mismatch" }));
  it("rejects the wrong issuer in the token", () =>
    rejected({ iss: "https://evil.test" }, {}, { reason: "id_token_invalid" }));
  it("rejects the wrong audience", () =>
    rejected({ aud: "another-client" }, {}, { reason: "id_token_invalid" }));
  it("rejects an expired token", () =>
    rejected({ expiresIn: -3600 }, {}, { reason: "id_token_invalid" }));
  it("rejects alg none", () => rejected({ alg: "none" }, {}, { reason: "id_token_invalid" }));
  it("rejects an HS256 token signed with the client secret", () =>
    rejected({ alg: "HS256" }, {}, { reason: "id_token_invalid" }));
  it("rejects a signature from an unpublished key", () =>
    rejected({ foreignKey: true }, {}, { reason: "id_token_invalid" }));
  it("rejects a callback iss that names another issuer", () =>
    rejected({}, { iss: "https://evil.test" }, { reason: "iss_mismatch" }));

  it("rejects an unknown state without a trace", async () => {
    const m = await workspace();
    await invite(m, `bo@${m.slug}.test`);
    const run = await signIn(harness(), m, { email: `bo@${m.slug}.test` }, {}, { state: "forged" });
    expect(run.callback.status).toBe(401);
    expect(await failures(m)).toHaveLength(0);
  });

  it("rejects a callback from a browser that did not start the sign-in", async () => {
    const m = await workspace();
    await invite(m, `bo@${m.slug}.test`);
    const app = harness();
    expect(
      (await signIn(app, m, { email: `bo@${m.slug}.test` }, {}, { cookie: null })).callback.status,
    ).toBe(401);
    expect(
      (await signIn(app, m, { email: `bo@${m.slug}.test` }, {}, { cookie: "other" })).callback
        .status,
    ).toBe(401);
  });

  it("uses a state once", async () => {
    const m = await workspace();
    await invite(m, `bo@${m.slug}.test`);
    const app = harness();
    const first = await signIn(app, m, { email: `bo@${m.slug}.test`, email_verified: true });
    expect(first.callback.status).toBe(302);
    const replay = await app.request(
      `/auth/oidc/callback?code=${first.code}&state=${first.state}&iss=${encodeURIComponent(idp.issuer)}`,
      { headers: { cookie: `__Host-oidc=${first.cookie}` } },
    );
    expect(replay.status).toBe(401);
    expect((await failures(m)).at(-1)?.details).toMatchObject({ reason: "replayed_request" });
  });

  it("does not accept an authorization code twice", async () => {
    const m = await workspace();
    await invite(m, `bo@${m.slug}.test`);
    const app = harness();
    const first = await signIn(app, m, { email: `bo@${m.slug}.test`, email_verified: true });
    expect(first.callback.status).toBe(302);
    // A fresh state, but the code already spent at the IdP.
    const start = await app.request(`/auth/oidc/start?workspace=${m.slug}`);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const res = await app.request(`/auth/oidc/callback?code=${first.code}&state=${state}`, {
      headers: { cookie: `__Host-oidc=${cookieOf(start)}` },
    });
    expect(res.status).toBe(401);
    expect((await failures(m)).at(-1)?.details).toMatchObject({ reason: "token_exchange_failed" });
  });

  it("rejects a request that has expired", async () => {
    const m = await workspace();
    await invite(m, `bo@${m.slug}.test`);
    const app = harness();
    const start = await app.request(`/auth/oidc/start?workspace=${m.slug}`);
    const location = start.headers.get("location") ?? "";
    await pool.query(
      "update core.oidc_auth_request set expires_at = now() - interval '1 second' where workspace_id = $1",
      [m.workspaceId],
    );
    const code = idp.authorize(location, { email: `bo@${m.slug}.test`, email_verified: true });
    const res = await app.request(
      `/auth/oidc/callback?code=${code}&state=${new URL(location).searchParams.get("state")}`,
      { headers: { cookie: `__Host-oidc=${cookieOf(start)}` } },
    );
    expect(res.status).toBe(401);
    expect((await failures(m)).at(-1)?.details).toMatchObject({ reason: "request_expired" });
  });
});

describe("keys and discovery", () => {
  it("caches discovery and keys, and refreshes the keys at once on an unknown kid", async () => {
    const m = await workspace();
    await invite(m, `bo@${m.slug}.test`);
    const app = harness(); // one service, so one cache
    const claims = { email: `bo@${m.slug}.test`, email_verified: true };
    const d0 = idp.hits.discovery;
    const j0 = idp.hits.jwks;
    expect((await signIn(app, m, claims)).callback.status).toBe(302);
    expect((await signIn(app, m, claims)).callback.status).toBe(302);
    expect(idp.hits.discovery - d0).toBe(1);
    expect(idp.hits.jwks - j0).toBe(1);

    await idp.rotateKey();
    expect((await signIn(app, m, claims)).callback.status).toBe(302);
    expect(idp.hits.jwks - j0).toBe(2);
  });
});

describe("passwords once SSO is on", () => {
  it("blocks a member's password but keeps an admin's as a way back in", async () => {
    const admin = await seedMember(pool);
    const memberId = (
      await pool.query<{ id: string }>(
        `insert into core.role (workspace_id, name, permissions) values ($1, 'Member', '{threads.use}') returning id`,
        [admin.workspaceId],
      )
    ).rows[0]?.id;
    const email = `pat@${admin.slug}.test`;
    const { rows } = await pool.query<{ id: string }>(
      `insert into core."user" (workspace_id, email, role_id, status) values ($1, $2, $3, 'active') returning id`,
      [admin.workspaceId, email, memberId],
    );
    const { hashPassword } = await import("../password.js");
    await pool.query("insert into core.password_credential values ($1, $2, $3)", [
      admin.workspaceId,
      rows[0]?.id,
      await hashPassword(PASSWORD),
    ]);
    const attempt = (e: string) =>
      auth.login({ workspace: admin.slug, email: e, password: PASSWORD }, client);

    expect(await attempt(email)).not.toBeNull();
    await providers.put(
      principalOf(admin),
      { issuer: idp.issuer, clientId: idp.clientId, enabled: true },
      null,
      client,
    );
    expect(await attempt(email)).toBeNull();
    expect(await attempt(admin.email)).not.toBeNull();
    await providers.put(
      principalOf(admin),
      { issuer: idp.issuer, clientId: idp.clientId, enabled: false },
      undefined,
      client,
    );
    expect(await attempt(email)).not.toBeNull();
  });
});

describe("storage", () => {
  it("keeps the client secret and auth requests out of the app role's reach", async () => {
    const m = await workspace();
    const read = (sql: string) => asApp(pool, principalOf(m), (db) => db.query(sql));
    await expect(read("select client_secret from core.oidc_provider_secret")).rejects.toMatchObject(
      { code: "42501" },
    );
    await expect(read("select * from core.oidc_auth_request")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      read(
        "insert into core.external_identity (workspace_id, user_id, issuer, subject, linked_via) values (gen_random_uuid(), gen_random_uuid(), 'x', 'y', 'email')",
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("lets only a configuration admin change the provider or its secret", async () => {
    const m = await workspace();
    const { rows } = await pool.query<{ id: string }>(
      `insert into core.role (workspace_id, name, permissions) values ($1, 'Member', '{threads.use}') returning id`,
      [m.workspaceId],
    );
    const member = (
      await pool.query<{ id: string }>(
        `insert into core."user" (workspace_id, email, role_id, status) values ($1, $2, $3, 'active') returning id`,
        [m.workspaceId, `pat@${m.slug}.test`, rows[0]?.id],
      )
    ).rows[0]?.id as string;
    const as = { userId: member, workspaceId: m.workspaceId, sessionId: "" };
    expect(await providers.get(as)).toBeNull(); // not even visible
    await expect(
      providers.put(as, { issuer: idp.issuer, clientId: "x" }, "s", client),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asApp(pool, as, (db) => db.query("select core.set_oidc_client_secret('x')")),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await providers.get(principalOf(m))).toMatchObject({
      clientId: idp.clientId,
      enabled: true,
    });
  });

  it("refuses an http issuer in production", async () => {
    const m = await seedMember(pool);
    await expect(
      createOidcProviders(pool).put(
        principalOf(m),
        { issuer: "http://idp.test", clientId: "x" },
        null,
        client,
      ),
    ).rejects.toThrow(/https/);
  });
});
