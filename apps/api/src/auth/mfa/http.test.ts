import { randomBytes } from "node:crypto";
import { createGateway } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import type { Language } from "../../addins/language.js";
import { createApp } from "../../app.js";
import { createDrafts } from "../../drafts/drafts.js";
import { PASSWORD, seedMember, testDocuments, testPool, testThreads } from "../../test-db.js";
import { createAuth } from "../auth.js";
import { createMfa } from "./service.js";
import { createAuthenticator } from "./test-authenticator.js";
import { hotp, stepOf } from "./totp.js";

const pool = testPool();
afterAll(() => pool.end());

const rpID = "legal.test";
const origin = "https://legal.test";

function harness() {
  const mfa = createMfa(pool, {
    rpID,
    rpName: "LegalLabs",
    origins: [origin],
    encryptionKey: randomBytes(32),
  });
  const app = createApp({
    auth: createAuth(pool),
    mfa,
    documents: testDocuments(pool),
    threads: testThreads(pool, testDocuments(pool)),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
    }),
    clientIp: () => "203.0.113.9",
    // The code route never reaches the language tools.
    addin: { language: {} as Language, recordSignIn: async () => {} },
  });
  const post = (path: string, body: unknown, cookie?: string) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const get = (path: string, cookie?: string) =>
    app.request(path, cookie ? { headers: { cookie } } : {});
  return { app, post, get };
}

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const json = async (res: Response) => (await res.json()) as Record<string, any>;

/** The base32 secret an enrolment begins with. */
function decodeSecret(base32: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of base32) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

describe("a pending sign-in", () => {
  it("is held in a cookie of the browser that started it, and nowhere else", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const login = await h.post("/auth/login", {
      workspace: m.slug,
      email: m.email,
      password: PASSWORD,
    });

    const set = login.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^__Host-mfa=[^;]{20,};/);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=600"]) {
      expect(set).toContain(flag);
    }
    expect(await json(login)).not.toHaveProperty("mfa_token");

    // Naming the token is not enough: a crafted link or another client has no cookie.
    const token = cookieOf(login).split("=")[1];
    const elsewhere = await h.post("/auth/mfa/enrol/totp/begin", { mfa_token: token });
    expect(elsewhere.status).toBe(401);
    expect(await json(elsewhere)).toEqual({ error: "invalid_mfa_token" });

    const here = await h.post("/auth/mfa/enrol/totp/begin", {}, cookieOf(login));
    expect(here.status).toBe(200);
  });
});

describe("the Word add-in's one-time code", () => {
  it("is refused until the second factor has passed", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const login = await h.post("/auth/login", {
      workspace: m.slug,
      email: m.email,
      password: PASSWORD,
    });
    const pending = cookieOf(login);

    // Neither the pending cookie nor its token passed off as a session gets one.
    for (const cookie of [pending, `__Host-sid=${pending.split("=")[1]}`]) {
      expect((await h.post("/auth/addin/code", {}, cookie)).status).toBe(401);
    }

    const begun = await json(await h.post("/auth/mfa/enrol/totp/begin", {}, pending));
    const done = await h.post(
      "/auth/mfa/enrol/totp/confirm",
      { code: hotp(decodeSecret(begun.secret), stepOf(Date.now())) },
      pending,
    );
    const sid = done.headers.getSetCookie().find((c) => c.startsWith("__Host-sid="));
    const issued = await h.post("/auth/addin/code", {}, sid?.split(";")[0]);
    expect(await json(issued)).toHaveProperty("code");
  });
});

describe("password + passkey sign-in over HTTP", () => {
  it("enrols a passkey at first sign-in, then needs it on the next one", async () => {
    const m = await seedMember(pool); // an admin, so the default policy covers them
    const h = harness();
    const device = createAuthenticator({ rpID, origin });
    const credentials = { workspace: m.slug, email: m.email, password: PASSWORD };

    // 1. Password alone gets no session, only an enrolment token.
    const first = await h.post("/auth/login", credentials);
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie")).not.toContain("__Host-sid");
    const firstBody = await json(first);
    expect(firstBody).toMatchObject({ mfa_enrolment_required: true, mfa_required: false });
    const pending = cookieOf(first);
    const enrolToken = pending.split("=")[1] ?? "";
    expect((await h.get("/auth/session")).status).toBe(401);

    // 2. The enrolment token opens nothing else.
    const nothing = await h.get("/api/v1/mfa", `__Host-sid=${enrolToken}`);
    expect(nothing.status).toBe(401);
    const noVerify = await h.post("/auth/mfa/passkey/options", {}, pending);
    expect(noVerify.status).toBe(409);

    // 3. Registering a passkey finishes the sign-in and returns recovery codes once.
    const regOptions = await json(await h.post("/auth/mfa/enrol/passkey/options", {}, pending));
    const enrolled = await h.post(
      "/auth/mfa/enrol/passkey/verify",
      {
        challenge_id: regOptions.challenge_id,
        response: device.register(regOptions.options),
        name: "Test key",
      },
      pending,
    );
    expect(enrolled.status).toBe(200);
    const enrolledBody = await json(enrolled);
    expect(enrolledBody.recovery_codes).toHaveLength(10);
    const firstCookie = cookieOf(enrolled);
    expect(firstCookie).toMatch(/^__Host-sid=/);
    expect((await h.get("/auth/session", firstCookie)).status).toBe(200);
    // The token cannot be spent again.
    const again = await h.post("/auth/mfa/enrol/passkey/options", {}, pending);
    expect(again.status).toBe(401);

    // 4. The next password sign-in is a challenge, with no cookie yet.
    const second = await h.post("/auth/login", credentials);
    const secondBody = await json(second);
    expect(second.headers.get("set-cookie")).not.toContain("__Host-sid");
    expect(secondBody).toMatchObject({ mfa_required: true, methods: ["passkey", "recovery"] });
    const challenged = cookieOf(second);

    // 5. A wrong assertion fails; the right one from the same device succeeds.
    const options = await json(await h.post("/auth/mfa/passkey/options", {}, challenged));
    const evil = await h.post(
      "/auth/mfa/passkey/verify",
      {
        challenge_id: options.challenge_id,
        response: device.assert(options.options, { origin: "https://evil.test" }),
      },
      challenged,
    );
    expect(evil.status).toBe(401);
    const options2 = await json(await h.post("/auth/mfa/passkey/options", {}, challenged));
    const done = await h.post(
      "/auth/mfa/passkey/verify",
      {
        challenge_id: options2.challenge_id,
        response: device.assert(options2.options),
      },
      challenged,
    );
    expect(done.status).toBe(200);
    const cookie = cookieOf(done);
    expect(done.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(done.headers.get("set-cookie")).toContain("__Host-mfa=; Max-Age=0");
    expect(await json(done)).toEqual({ user_id: m.userId, workspace_id: m.workspaceId });

    // 6. The session works, and carries mfa_at.
    expect((await h.get("/auth/session", cookie)).status).toBe(200);
    const status = await json(await h.get("/api/v1/mfa", cookie));
    expect(status.passkeys).toHaveLength(1);
    expect(status.mfa_at).toBeTruthy();
    expect(status.required).toBe(true);
  });

  it("signs in with a passkey alone, and refuses an assertion for the wrong workspace", async () => {
    const m = await seedMember(pool);
    const other = await seedMember(pool);
    const h = harness();
    const device = createAuthenticator({ rpID, origin });
    const login = cookieOf(
      await h.post("/auth/login", { workspace: m.slug, email: m.email, password: PASSWORD }),
    );
    const reg = await json(await h.post("/auth/mfa/enrol/passkey/options", {}, login));
    await h.post(
      "/auth/mfa/enrol/passkey/verify",
      {
        challenge_id: reg.challenge_id,
        response: device.register(reg.options),
      },
      login,
    );

    const options = await json(await h.post("/auth/passkey/options", { workspace: m.slug }));
    const ok = await h.post("/auth/passkey/verify", {
      workspace: m.slug,
      challenge_id: options.challenge_id,
      response: device.assert(options.options),
    });
    expect(ok.status).toBe(200);
    expect((await h.get("/auth/session", cookieOf(ok))).status).toBe(200);

    const wrongOptions = await json(
      await h.post("/auth/passkey/options", { workspace: other.slug }),
    );
    const wrong = await h.post("/auth/passkey/verify", {
      workspace: other.slug,
      challenge_id: wrongOptions.challenge_id,
      response: device.assert(wrongOptions.options),
    });
    expect(wrong.status).toBe(401);
  });
});

describe("authenticator app over HTTP", () => {
  it("enrols, signs in with a code, refuses its replay, and gates sensitive actions on step-up", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const credentials = { workspace: m.slug, email: m.email, password: PASSWORD };
    const enrol = cookieOf(await h.post("/auth/login", credentials));
    const begun = await json(await h.post("/auth/mfa/enrol/totp/begin", {}, enrol));
    expect(begun.uri).toMatch(/^otpauth:\/\/totp\//);
    const secret = decodeSecret(begun.secret);
    const step = stepOf(Date.now());
    const confirmed = await h.post(
      "/auth/mfa/enrol/totp/confirm",
      {
        code: hotp(secret, step),
      },
      enrol,
    );
    expect(confirmed.status).toBe(200);
    const cookie = cookieOf(confirmed);

    // The same step cannot sign in again (replay), but the next one can.
    const challenge = cookieOf(await h.post("/auth/login", credentials));
    const replay = await h.post(
      "/auth/mfa/totp",
      {
        code: hotp(secret, step),
      },
      challenge,
    );
    expect(replay.status).toBe(401);
    const next = await h.post(
      "/auth/mfa/totp",
      {
        code: hotp(secret, step + 1),
      },
      challenge,
    );
    expect(next.status).toBe(200);

    // A session that has not shown a factor recently cannot remove one.
    const stale = await seedStaleSession(m, h);
    const refused = await h.app.request("/api/v1/mfa/totp", {
      method: "DELETE",
      headers: { cookie: stale },
    });
    expect(refused.status).toBe(403);
    expect((await json(refused)).code).toBe("MFA_REQUIRED");
    expect(cookie).toMatch(/^__Host-sid=/);
  });
});

// Signs in through the plain Auth, which leaves mfa_at empty, as an old session would be.
async function seedStaleSession(m: { slug: string; email: string }, h: ReturnType<typeof harness>) {
  const auth = createAuth(pool);
  const result = await auth.login(
    { workspace: m.slug, email: m.email, password: PASSWORD },
    { ip: null, userAgent: null },
  );
  void h;
  return `__Host-sid=${result?.token}`;
}
