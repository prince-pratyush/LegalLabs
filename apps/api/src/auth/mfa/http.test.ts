import { randomBytes } from "node:crypto";
import { createGateway } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
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

describe("password + passkey sign-in over HTTP", () => {
  it("enrols a passkey at first sign-in, then needs it on the next one", async () => {
    const m = await seedMember(pool); // an admin, so the default policy covers them
    const h = harness();
    const device = createAuthenticator({ rpID, origin });
    const credentials = { workspace: m.slug, email: m.email, password: PASSWORD };

    // 1. Password alone gets no session, only an enrolment token.
    const first = await h.post("/auth/login", credentials);
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie")).toBeNull();
    const firstBody = await json(first);
    expect(firstBody).toMatchObject({ mfa_enrolment_required: true, mfa_required: false });
    const enrolToken = firstBody.mfa_token as string;
    expect((await h.get("/auth/session")).status).toBe(401);

    // 2. The enrolment token opens nothing else.
    const nothing = await h.get("/api/v1/mfa", `__Host-sid=${enrolToken}`);
    expect(nothing.status).toBe(401);
    const noVerify = await h.post("/auth/mfa/passkey/options", { mfa_token: enrolToken });
    expect(noVerify.status).toBe(409);

    // 3. Registering a passkey finishes the sign-in and returns recovery codes once.
    const regOptions = await json(
      await h.post("/auth/mfa/enrol/passkey/options", { mfa_token: enrolToken }),
    );
    const enrolled = await h.post("/auth/mfa/enrol/passkey/verify", {
      mfa_token: enrolToken,
      challenge_id: regOptions.challenge_id,
      response: device.register(regOptions.options),
      name: "Test key",
    });
    expect(enrolled.status).toBe(200);
    const enrolledBody = await json(enrolled);
    expect(enrolledBody.recovery_codes).toHaveLength(10);
    const firstCookie = cookieOf(enrolled);
    expect(firstCookie).toMatch(/^__Host-sid=/);
    expect((await h.get("/auth/session", firstCookie)).status).toBe(200);
    // The token cannot be spent again.
    const again = await h.post("/auth/mfa/enrol/passkey/options", { mfa_token: enrolToken });
    expect(again.status).toBe(401);

    // 4. The next password sign-in is a challenge, with no cookie yet.
    const second = await h.post("/auth/login", credentials);
    const secondBody = await json(second);
    expect(second.headers.get("set-cookie")).toBeNull();
    expect(secondBody).toMatchObject({ mfa_required: true, methods: ["passkey", "recovery"] });
    const token = secondBody.mfa_token as string;

    // 5. A wrong assertion fails; the right one from the same device succeeds.
    const options = await json(await h.post("/auth/mfa/passkey/options", { mfa_token: token }));
    const evil = await h.post("/auth/mfa/passkey/verify", {
      mfa_token: token,
      challenge_id: options.challenge_id,
      response: device.assert(options.options, { origin: "https://evil.test" }),
    });
    expect(evil.status).toBe(401);
    const options2 = await json(await h.post("/auth/mfa/passkey/options", { mfa_token: token }));
    const done = await h.post("/auth/mfa/passkey/verify", {
      mfa_token: token,
      challenge_id: options2.challenge_id,
      response: device.assert(options2.options),
    });
    expect(done.status).toBe(200);
    const cookie = cookieOf(done);
    expect(done.headers.get("set-cookie")).toMatch(/HttpOnly/);
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
    const login = await json(
      await h.post("/auth/login", { workspace: m.slug, email: m.email, password: PASSWORD }),
    );
    const reg = await json(
      await h.post("/auth/mfa/enrol/passkey/options", { mfa_token: login.mfa_token }),
    );
    await h.post("/auth/mfa/enrol/passkey/verify", {
      mfa_token: login.mfa_token,
      challenge_id: reg.challenge_id,
      response: device.register(reg.options),
    });

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
    const enrol = await json(await h.post("/auth/login", credentials));
    const begun = await json(
      await h.post("/auth/mfa/enrol/totp/begin", { mfa_token: enrol.mfa_token }),
    );
    expect(begun.uri).toMatch(/^otpauth:\/\/totp\//);
    const secret = Buffer.from(
      // base32 secret from the begin response
      (() => {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        let bits = 0;
        let value = 0;
        const out: number[] = [];
        for (const ch of begun.secret as string) {
          value = (value << 5) | alphabet.indexOf(ch);
          bits += 5;
          if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
          }
        }
        return out;
      })(),
    );
    const step = stepOf(Date.now());
    const confirmed = await h.post("/auth/mfa/enrol/totp/confirm", {
      mfa_token: enrol.mfa_token,
      code: hotp(secret, step),
    });
    expect(confirmed.status).toBe(200);
    const cookie = cookieOf(confirmed);

    // The same step cannot sign in again (replay), but the next one can.
    const challenge = await json(await h.post("/auth/login", credentials));
    const replay = await h.post("/auth/mfa/totp", {
      mfa_token: challenge.mfa_token,
      code: hotp(secret, step),
    });
    expect(replay.status).toBe(401);
    const next = await h.post("/auth/mfa/totp", {
      mfa_token: challenge.mfa_token,
      code: hotp(secret, step + 1),
    });
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
