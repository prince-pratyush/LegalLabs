import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { asApp } from "../../db.js";
import { auditTrail, PASSWORD, type Seeded, seedMember, testPool } from "../../test-db.js";
import { createAuth, type Principal } from "../auth.js";
import { hashPassword } from "../password.js";
import { createMfa, type LoginOutcome, type Subject } from "./service.js";
import { hasFreshMfa, MfaRequiredError, requireFreshMfa } from "./step-up.js";
import { createAuthenticator } from "./test-authenticator.js";
import { hotp, stepOf } from "./totp.js";

const pool = testPool();
afterAll(() => pool.end());

const rpID = "legal.test";
const origin = "https://legal.test";
let clock = Date.now();
const mfa = createMfa(pool, {
  rpID,
  rpName: "LegalLabs",
  origins: [origin],
  encryptionKey: randomBytes(32),
  now: () => clock,
});
const auth = createAuth(pool);
const client = { ip: "203.0.113.9", userAgent: "vitest" };

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const base32Decode = (text: string) => {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};
const codeAt = (secret: Buffer, offsetSteps = 0) => hotp(secret, stepOf(clock) + offsetSteps);
const nextStep = () => {
  clock += 30_000;
};

async function addUser(
  m: Seeded,
  opts: { kind?: "member" | "guest"; permissions?: string[]; status?: string } = {},
): Promise<Seeded> {
  const email = `u${randomUUID().slice(0, 8)}@${m.slug}.test`;
  const guest = opts.kind === "guest";
  // Guests hold no role: the schema forbids it.
  const role = guest
    ? null
    : (
        await pool.query<{ id: string }>(
          "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
          [m.workspaceId, `r-${randomUUID().slice(0, 6)}`, opts.permissions ?? ["threads.use"]],
        )
      ).rows[0]?.id;
  const userId =
    (
      await pool.query<{ id: string }>(
        `insert into core."user" (workspace_id, email, role_id, status, kind)
         values ($1, $2, $3, $4, $5) returning id`,
        [m.workspaceId, email, role, opts.status ?? "active", opts.kind ?? "member"],
      )
    ).rows[0]?.id ?? "";
  if (!guest) {
    await pool.query(
      "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
      [m.workspaceId, userId, await hashPassword(PASSWORD)],
    );
  }
  return { ...m, userId, email };
}

const setPolicy = (m: Seeded, policy: string | null) =>
  pool.query(
    policy === null
      ? "update core.workspace set settings = '{}' where id = $1"
      : `update core.workspace set settings = jsonb_build_object('mfa', '${policy}'::text) where id = $1`,
    [m.workspaceId],
  );

const loginOf = (m: Seeded) =>
  mfa.login({ workspace: m.slug, email: m.email, password: PASSWORD }, client);

async function sessionOf(m: Seeded): Promise<Principal> {
  const outcome = await auth.login(
    { workspace: m.slug, email: m.email, password: PASSWORD },
    client,
  );
  if (!outcome) throw new Error("sign-in failed");
  return outcome.principal;
}

/** Enrols an authenticator app for the person, returning its secret. */
async function enrolTotp(s: Subject): Promise<{ secret: Buffer; recoveryCodes: string[] | null }> {
  const begun = await mfa.totpBegin(s);
  if (!begun) throw new Error("already enrolled");
  const secret = base32Decode(begun.secret);
  const done = await mfa.totpConfirm(s, codeAt(secret), client);
  if (!done.ok) throw new Error("confirm failed");
  nextStep();
  return { secret, recoveryCodes: done.recoveryCodes };
}

const kindOf = (outcome: LoginOutcome | null) => outcome?.kind;
const actions = async (m: Seeded) => (await auditTrail(pool, m.workspaceId)).map((r) => r.action);

describe("the workspace policy", () => {
  // member: an ordinary person; admin: holds admin permissions; guest: an outside collaborator.
  const required = async (policy: string | null) => {
    const admin = await seedMember(pool);
    const member = await addUser(admin);
    const guest = await addUser(admin, { kind: "guest" });
    await setPolicy(admin, policy);
    const ask = async (s: Subject) => (await mfa.status(s)).required;
    return { admin: await ask(admin), member: await ask(member), guest: await ask(guest) };
  };

  it("off asks nobody", async () => {
    expect(await required("off")).toEqual({ admin: false, member: false, guest: false });
  });

  it("admins asks only people holding admin permissions, and is the default", async () => {
    expect(await required("admins")).toEqual({ admin: true, member: false, guest: false });
    expect(await required(null)).toEqual({ admin: true, member: false, guest: false });
  });

  it("all asks every member but not guests", async () => {
    expect(await required("all")).toEqual({ admin: true, member: true, guest: false });
  });

  it("all_incl_guests asks everyone", async () => {
    expect(await required("all_incl_guests")).toEqual({ admin: true, member: true, guest: true });
  });

  it("a partial admin permission counts as an admin", async () => {
    const m = await seedMember(pool);
    const dee = await addUser(m, { permissions: ["admin.users"] });
    expect((await mfa.status(dee)).required).toBe(true);
  });

  it("refuses a value outside the four policies", async () => {
    const m = await seedMember(pool);
    await expect(
      pool.query(`update core.workspace set settings = '{"mfa":"maybe"}' where id = $1`, [
        m.workspaceId,
      ]),
    ).rejects.toThrow(/workspace_mfa_policy/);
  });
});

describe("password sign-in with a policy", () => {
  it("signs straight in when nothing is required and nothing is enrolled", async () => {
    const m = await seedMember(pool);
    await setPolicy(m, "off");
    const outcome = await loginOf(m);
    expect(kindOf(outcome)).toBe("session");
    if (outcome?.kind === "session") expect(outcome.principal.mfaAt).toBeNull();
  });

  it("sends a covered person with no factor to enrolment, and mints no session", async () => {
    const m = await seedMember(pool); // admin, default policy
    const outcome = await loginOf(m);
    expect(kindOf(outcome)).toBe("enrol");
    const { rows } = await pool.query(
      "select count(*)::int as n from core.session where user_id = $1",
      [m.userId],
    );
    expect(rows[0].n).toBe(0);
    expect(await actions(m)).toEqual(["login.mfa_challenge"]);
  });

  it("challenges a person with a factor, offering the methods they have", async () => {
    const m = await seedMember(pool);
    await enrolTotp(m);
    const outcome = await loginOf(m);
    expect(outcome).toMatchObject({ kind: "challenge", methods: ["totp", "recovery"] });
  });

  it("honours a factor someone enrolled even where the policy asks nothing", async () => {
    const m = await seedMember(pool);
    await setPolicy(m, "off");
    await enrolTotp(m);
    expect(kindOf(await loginOf(m))).toBe("challenge");
  });

  it("completes with a current code, sets mfa_at and records how they signed in", async () => {
    const m = await seedMember(pool);
    const { secret } = await enrolTotp(m);
    const outcome = await loginOf(m);
    if (outcome?.kind !== "challenge") throw new Error("expected a challenge");
    const pending = await mfa.pendingOf(outcome.mfaToken);
    if (!pending) throw new Error("no pending sign-in");
    const session = await mfa.completeTotp(pending, codeAt(secret), client);
    expect(session?.principal.mfaAt).toBeInstanceOf(Date);
    // The new session resolves with mfa_at exposed.
    const resolved = await auth.resolve(session?.token ?? "");
    expect(resolved?.mfaAt).toBeInstanceOf(Date);
    const trail = await auditTrail(pool, m.workspaceId);
    expect(trail.map((r) => r.action)).toEqual([
      "mfa.enrolled",
      "login.mfa_challenge",
      "login.success",
    ]);
    expect(trail[2]?.details).toEqual({ method: "password+totp" });
  });

  it("does not turn a pending sign-in into a second session", async () => {
    const m = await seedMember(pool);
    const { secret } = await enrolTotp(m);
    const outcome = await loginOf(m);
    if (outcome?.kind !== "challenge") throw new Error("expected a challenge");
    const pending = await mfa.pendingOf(outcome.mfaToken);
    if (!pending) throw new Error("no pending sign-in");
    expect(await mfa.completeTotp(pending, codeAt(secret), client)).not.toBeNull();
    expect(await mfa.pendingOf(outcome.mfaToken)).toBeNull();
  });

  it("retires the pending sign-in after five wrong codes and records each", async () => {
    const m = await seedMember(pool);
    const { secret } = await enrolTotp(m);
    const outcome = await loginOf(m);
    if (outcome?.kind !== "challenge") throw new Error("expected a challenge");
    const pending = await mfa.pendingOf(outcome.mfaToken);
    if (!pending) throw new Error("no pending sign-in");
    for (let i = 0; i < 5; i++)
      expect(await mfa.completeTotp(pending, "000000", client)).toBeNull();
    expect(await mfa.pendingOf(outcome.mfaToken)).toBeNull();
    const failures = (await auditTrail(pool, m.workspaceId)).filter(
      (r) => r.action === "login.failure",
    );
    expect(failures).toHaveLength(5);
    expect(failures[0]).toMatchObject({
      actor_type: "system",
      object_id: m.userId,
      details: { reason: "bad_totp", method: "totp" },
    });
    // Even the right code no longer works: the person must start over.
    expect(await mfa.pendingOf(outcome.mfaToken)).toBeNull();
    expect(secret.length).toBe(20);
  });

  it("will not use an enrolment pending sign-in as a second factor", async () => {
    const m = await seedMember(pool);
    const outcome = await loginOf(m);
    if (outcome?.kind !== "enrol") throw new Error("expected enrolment");
    const pending = await mfa.pendingOf(outcome.mfaToken);
    if (!pending) throw new Error("no pending sign-in");
    expect(await mfa.completeRecovery(pending, "AAAA-AAAA-AAAA-AAAA", client)).toBeNull();
    expect(await mfa.finishEnrolment({ ...pending, purpose: "verify" }, "totp", client)).toBeNull();
  });

  it("completes enrolment into a first session, with recovery codes", async () => {
    const m = await seedMember(pool);
    const outcome = await loginOf(m);
    if (outcome?.kind !== "enrol") throw new Error("expected enrolment");
    const pending = await mfa.pendingOf(outcome.mfaToken);
    if (!pending) throw new Error("no pending sign-in");
    const begun = await mfa.totpBegin(pending);
    const secret = base32Decode(begun?.secret ?? "");
    expect((await mfa.totpConfirm(pending, "123456", client)).ok).toBe(false);
    const done = await mfa.totpConfirm(pending, codeAt(secret), client);
    expect(done.ok && done.recoveryCodes).toHaveLength(10);
    const session = await mfa.finishEnrolment(pending, "totp", client);
    expect(session?.principal.mfaAt).toBeInstanceOf(Date);
    expect(await mfa.finishEnrolment(pending, "totp", client)).toBeNull();
  });

  it("refuses a suspended person's second factor", async () => {
    const m = await seedMember(pool);
    const { secret } = await enrolTotp(m);
    const outcome = await loginOf(m);
    if (outcome?.kind !== "challenge") throw new Error("expected a challenge");
    await pool.query(`update core."user" set status = 'suspended' where id = $1`, [m.userId]);
    expect(await mfa.pendingOf(outcome.mfaToken)).toBeNull();
    expect(secret).toBeDefined();
  });

  it("does not reveal an unknown account any differently", async () => {
    const m = await seedMember(pool);
    expect(
      await mfa.login({ workspace: m.slug, email: "x@y.test", password: PASSWORD }, client),
    ).toBeNull();
    expect(
      await mfa.login({ workspace: m.slug, email: m.email, password: "nope" }, client),
    ).toBeNull();
    expect((await actions(m)).filter((a) => a === "login.failure")).toHaveLength(2);
  });
});

describe("authenticator codes", () => {
  it("are stored sealed, and the app role cannot read the table", async () => {
    const m = await seedMember(pool);
    const begun = await mfa.totpBegin(m);
    const { rows } = await pool.query("select secret_enc from core.mfa_totp where user_id = $1", [
      m.userId,
    ]);
    const stored = Buffer.from(rows[0].secret_enc);
    expect(stored.includes(base32Decode(begun?.secret ?? ""))).toBe(false);
    await expect(
      asApp(pool, m, (db) => db.query("select secret_enc from core.mfa_totp")),
    ).rejects.toThrow(/permission denied/);
  });

  it("are refused when the stored secret was copied onto another person", async () => {
    const m = await seedMember(pool);
    const other = await addUser(m);
    const { secret } = await enrolTotp(m);
    await pool.query(
      `insert into core.mfa_totp (workspace_id, user_id, secret_enc, confirmed_at)
       select workspace_id, $2, secret_enc, now() from core.mfa_totp where user_id = $1`,
      [m.userId, other.userId],
    );
    expect(await mfa.verifyTotp(other, codeAt(secret))).toBe(false);
  });

  it("work once: the same code, or an older step, is refused afterwards", async () => {
    const m = await seedMember(pool);
    const { secret } = await enrolTotp(m);
    const code = codeAt(secret);
    expect(await mfa.verifyTotp(m, code)).toBe(true);
    expect(await mfa.verifyTotp(m, code)).toBe(false);
    // The previous step is inside the window but older than the one just used.
    expect(await mfa.verifyTotp(m, codeAt(secret, -1))).toBe(false);
    // The next step, still inside the window, is fresh.
    expect(await mfa.verifyTotp(m, codeAt(secret, 1))).toBe(true);
  });

  it("refuse two simultaneous uses of one code", async () => {
    const m = await seedMember(pool);
    const { secret } = await enrolTotp(m);
    const code = codeAt(secret);
    const results = await Promise.all([mfa.verifyTotp(m, code), mfa.verifyTotp(m, code)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("are refused outside the one-step window", async () => {
    const m = await seedMember(pool);
    const { secret } = await enrolTotp(m);
    expect(await mfa.verifyTotp(m, codeAt(secret, 2))).toBe(false);
    expect(await mfa.verifyTotp(m, codeAt(secret, -2))).toBe(false);
  });

  it("do not count until confirmed, and cannot be enrolled twice", async () => {
    const m = await seedMember(pool);
    const begun = await mfa.totpBegin(m);
    const secret = base32Decode(begun?.secret ?? "");
    expect(await mfa.verifyTotp(m, codeAt(secret))).toBe(false);
    expect((await mfa.status(m)).totp).toBe(false);
    await mfa.totpConfirm(m, codeAt(secret), client);
    expect(await mfa.totpBegin(m)).toBeNull();
  });
});

describe("recovery codes", () => {
  it("come with the first factor, work once, and are normalised when typed", async () => {
    const m = await seedMember(pool);
    const { recoveryCodes } = await enrolTotp(m);
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes?.[0]).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    const code = recoveryCodes?.[0] ?? "";
    const sloppy = code.toLowerCase().replaceAll("-", " ");
    expect(await mfa.verifyRecovery(m, sloppy)).toBe(true);
    expect(await mfa.verifyRecovery(m, code)).toBe(false);
    expect((await mfa.status(m)).recoveryRemaining).toBe(9);
  });

  it("are stored only as hashes", async () => {
    const m = await seedMember(pool);
    const { recoveryCodes } = await enrolTotp(m);
    const { rows } = await pool.query(
      "select code_hash from core.mfa_recovery_code where user_id = $1",
      [m.userId],
    );
    const plain = (recoveryCodes ?? []).map((c) => c.replaceAll("-", ""));
    for (const row of rows) expect(plain).not.toContain(Buffer.from(row.code_hash).toString());
  });

  it("sign in once, then are spent", async () => {
    const m = await seedMember(pool);
    const { recoveryCodes } = await enrolTotp(m);
    const outcome = await loginOf(m);
    if (outcome?.kind !== "challenge") throw new Error("expected a challenge");
    const pending = await mfa.pendingOf(outcome.mfaToken);
    if (!pending) throw new Error("no pending sign-in");
    const session = await mfa.completeRecovery(pending, recoveryCodes?.[1] ?? "", client);
    expect(session).not.toBeNull();
    const second = await loginOf(m);
    if (second?.kind !== "challenge") throw new Error("expected a challenge");
    const again = await mfa.pendingOf(second.mfaToken);
    expect(await mfa.completeRecovery(again as never, recoveryCodes?.[1] ?? "", client)).toBeNull();
    const last = (await auditTrail(pool, m.workspaceId)).at(-1);
    expect(last).toMatchObject({ action: "login.failure", details: { reason: "bad_recovery" } });
  });

  it("are replaced as a set", async () => {
    const m = await seedMember(pool);
    const { recoveryCodes } = await enrolTotp(m);
    const fresh = await mfa.regenerateRecovery(m, client);
    expect(fresh).toHaveLength(10);
    expect(await mfa.verifyRecovery(m, recoveryCodes?.[0] ?? "")).toBe(false);
    expect(await mfa.verifyRecovery(m, fresh[0] ?? "")).toBe(true);
  });
});

describe("step-up", () => {
  it("requireFreshMfa passes within the window and throws outside it or with none", () => {
    const now = 10_000_000;
    const at = (ms: number) => ({ mfaAt: new Date(now - ms) });
    expect(() => requireFreshMfa(at(60_000), 15 * 60_000, now)).not.toThrow();
    expect(() => requireFreshMfa(at(16 * 60_000), 15 * 60_000, now)).toThrow(MfaRequiredError);
    expect(() => requireFreshMfa({ mfaAt: null }, 15 * 60_000, now)).toThrow(MfaRequiredError);
    expect(() => requireFreshMfa({}, 15 * 60_000, now)).toThrow(MfaRequiredError);
    expect(hasFreshMfa({ mfaAt: new Date(now + 60_000) }, 15 * 60_000, now)).toBe(false);
  });

  it("markFresh stamps the session, which then reads as fresh", async () => {
    const m = await seedMember(pool);
    await enrolTotp(m);
    const principal = await sessionOf(m);
    expect(hasFreshMfa(principal)).toBe(false);
    const at = await mfa.markFresh(principal, client, "totp");
    expect(at).toBeInstanceOf(Date);
    const { rows } = await pool.query("select mfa_at from core.session where id = $1", [
      principal.sessionId,
    ]);
    expect(rows[0].mfa_at).toEqual(at);
    expect(await actions(m)).toContain("mfa.verified");
  });

  it("only a person with a factor can be asked for one", async () => {
    const m = await seedMember(pool);
    expect(await mfa.hasFactor(m)).toBe(false);
    await enrolTotp(m);
    expect(await mfa.hasFactor(m)).toBe(true);
  });
});

describe("removing a factor", () => {
  it("is refused for the last one when the policy requires MFA", async () => {
    const m = await seedMember(pool);
    await enrolTotp(m);
    await expect(mfa.removeTotp(m, client)).rejects.toThrow(/cannot be removed/);
    expect((await mfa.status(m)).totp).toBe(true);
  });

  it("is allowed where MFA is optional, and clears the recovery codes with it", async () => {
    const m = await seedMember(pool);
    await setPolicy(m, "off");
    await enrolTotp(m);
    expect(await mfa.removeTotp(m, client)).toBe(true);
    expect((await mfa.status(m)).recoveryRemaining).toBe(0);
    expect(await actions(m)).toContain("mfa.removed");
  });
});

describe("resetting someone else's factors", () => {
  it("is allowed for an admin, signs the target out, and is audited", async () => {
    const admin = await seedMember(pool);
    const target = await addUser(admin);
    await enrolTotp(target);
    const targetSession = await sessionOf(target);
    const adminSession = await sessionOf(admin);
    const result = await mfa.resetUser(adminSession, target.userId, client);
    expect(result).toEqual({ ok: true, removed: 1 });
    expect((await mfa.status(target)).totp).toBe(false);
    expect((await mfa.status(target)).recoveryRemaining).toBe(0);
    expect(await auth.resolve(await tokenFor(targetSession))).toBeNull();
    const last = (await auditTrail(pool, admin.workspaceId)).at(-1);
    expect(last).toMatchObject({
      action: "mfa.reset",
      actor_id: admin.userId,
      object_id: target.userId,
    });
  });

  it("is refused for a member without admin.users", async () => {
    const m = await seedMember(pool);
    const peer = await addUser(m);
    const victim = await addUser(m);
    await enrolTotp(victim);
    const peerSession = await sessionOf(peer);
    expect(await mfa.resetUser(peerSession, victim.userId, client)).toEqual({ ok: false });
    expect((await mfa.status(victim)).totp).toBe(true);
  });

  it("is allowed for a partial admin holding admin.users", async () => {
    const m = await seedMember(pool);
    const dee = await addUser(m, { permissions: ["admin.users"] });
    const victim = await addUser(m);
    await enrolTotp(victim);
    expect(await mfa.resetUser(await sessionOf(dee), victim.userId, client)).toMatchObject({
      ok: true,
    });
  });

  it("is refused across workspaces", async () => {
    const a = await seedMember(pool);
    const b = await seedMember(pool);
    await enrolTotp(b);
    expect(await mfa.resetUser(await sessionOf(a), b.userId, client)).toEqual({ ok: false });
    expect((await mfa.status(b)).totp).toBe(true);
  });

  it("is refused for a guest, who never holds admin permissions", async () => {
    const m = await seedMember(pool);
    const guest = await addUser(m, { kind: "guest", permissions: ["*"] });
    const victim = await addUser(m);
    await enrolTotp(victim);
    const guestSession = {
      sessionId: "",
      userId: guest.userId,
      workspaceId: m.workspaceId,
    };
    expect(await mfa.resetUser(guestSession, victim.userId, client)).toEqual({ ok: false });
  });

  it("lets an admin read a summary of another person, but not a member of someone else", async () => {
    const m = await seedMember(pool);
    const peer = await addUser(m);
    const other = await addUser(m);
    await enrolTotp(other);
    expect(await mfa.summaryOf(await sessionOf(m), other.userId)).toMatchObject({ has_totp: true });
    expect(await mfa.summaryOf(await sessionOf(peer), other.userId)).toBeNull();
    const elsewhere = await seedMember(pool);
    expect(await mfa.summaryOf(await sessionOf(m), elsewhere.userId)).toBeNull();
  });
});

describe("changing the policy", () => {
  it("needs admin.config, takes effect and is audited", async () => {
    const m = await seedMember(pool);
    const peer = await addUser(m);
    expect(await mfa.setPolicy(await sessionOf(peer), "off", client)).toBe(false);
    expect(await mfa.setPolicy(await sessionOf(m), "all", client)).toBe(true);
    expect((await mfa.status(peer)).required).toBe(true);
    const last = (await auditTrail(pool, m.workspaceId)).at(-1);
    expect(last).toMatchObject({
      action: "mfa.policy_changed",
      object_type: "workspace",
      details: { from: "admins", to: "all" },
    });
  });
});

describe("isolation between workspaces", () => {
  it("never lets one workspace read or use another's factors", async () => {
    const a = await seedMember(pool);
    const b = await seedMember(pool);
    const { secret } = await enrolTotp(a);
    // Acting as A's user inside B's workspace finds nothing.
    const cross = { userId: a.userId, workspaceId: b.workspaceId };
    expect(await mfa.verifyTotp(cross, codeAt(secret))).toBe(false);
    expect((await mfa.status(cross)).totp).toBe(false);
    await expect(mfa.passkeyOptionsFor(cross)).resolves.toBeNull();
    // And B's admin cannot see the row, even by guessing the table.
    await expect(asApp(pool, b, (db) => db.query("select * from core.mfa_totp"))).rejects.toThrow(
      /permission denied/,
    );
  });
});

async function tokenFor(principal: Principal): Promise<string> {
  // Sessions are looked up by hash, so a revoked one is checked through the table instead.
  const { rows } = await pool.query("select revoked_at from core.session where id = $1", [
    principal.sessionId,
  ]);
  return rows[0].revoked_at ? "revoked" : "live";
}

describe("passkeys", () => {
  const rp = { rpID, origin };

  async function enrolPasskey(s: Subject, device = createAuthenticator(rp)) {
    const request = await mfa.passkeyRegisterOptions(s);
    const done = await mfa.passkeyRegisterVerify(
      s,
      request.challengeId,
      device.register(request.options),
      "Laptop",
      client,
    );
    return { device, done };
  }

  it("register, list, and give recovery codes with the first factor", async () => {
    const m = await seedMember(pool);
    const { done } = await enrolPasskey(m);
    expect(done.ok && done.recoveryCodes).toHaveLength(10);
    const status = await mfa.status(m);
    expect(status.passkeys.map((k) => k.name)).toEqual(["Laptop"]);
    expect(await actions(m)).toEqual(["mfa.enrolled"]);
  });

  it("refuse a registration from the wrong origin, a wrong challenge, or a device that never verifies", async () => {
    const m = await seedMember(pool);
    const device = createAuthenticator(rp);
    const a = await mfa.passkeyRegisterOptions(m);
    expect(
      (
        await mfa.passkeyRegisterVerify(
          m,
          a.challengeId,
          device.register(a.options, { origin: "https://evil.test" }),
          "x",
          client,
        )
      ).ok,
    ).toBe(false);
    const b = await mfa.passkeyRegisterOptions(m);
    expect(
      (
        await mfa.passkeyRegisterVerify(
          m,
          b.challengeId,
          device.register(b.options, { challenge: "AAAA" }),
          "x",
          client,
        )
      ).ok,
    ).toBe(false);
    const c = await mfa.passkeyRegisterOptions(m);
    const lazy = createAuthenticator({ ...rp, userVerifies: false });
    expect(
      (await mfa.passkeyRegisterVerify(m, c.challengeId, lazy.register(c.options), "x", client)).ok,
    ).toBe(false);
    expect((await mfa.status(m)).passkeys).toEqual([]);
  });

  it("use a challenge once", async () => {
    const m = await seedMember(pool);
    const device = createAuthenticator(rp);
    const request = await mfa.passkeyRegisterOptions(m);
    const response = device.register(request.options);
    expect(
      (await mfa.passkeyRegisterVerify(m, request.challengeId, response, "a", client)).ok,
    ).toBe(true);
    expect(
      (await mfa.passkeyRegisterVerify(m, request.challengeId, response, "b", client)).ok,
    ).toBe(false);
  });

  it("let a challenge expire", async () => {
    const m = await seedMember(pool);
    const device = createAuthenticator(rp);
    const request = await mfa.passkeyRegisterOptions(m);
    await pool.query(
      "update core.mfa_challenge set expires_at = now() - interval '1 second' where id = $1",
      [request.challengeId],
    );
    expect(
      (
        await mfa.passkeyRegisterVerify(
          m,
          request.challengeId,
          device.register(request.options),
          "a",
          client,
        )
      ).ok,
    ).toBe(false);
  });

  it("refuse a challenge issued to someone else", async () => {
    const m = await seedMember(pool);
    const other = await addUser(m);
    const device = createAuthenticator(rp);
    const request = await mfa.passkeyRegisterOptions(m);
    const done = await mfa.passkeyRegisterVerify(
      other,
      request.challengeId,
      device.register(request.options),
      "a",
      client,
    );
    expect(done.ok).toBe(false);
  });

  it("verify an assertion, move the counter, and refuse a replay of an old counter", async () => {
    const m = await seedMember(pool);
    const { device } = await enrolPasskey(m);
    const first = await mfa.passkeyOptionsFor(m);
    if (!first) throw new Error("no options");
    expect(await mfa.verifyPasskey(m, first.challengeId, device.assert(first.options))).toBe(true);
    // A clone that signs with a counter at or below the stored one is refused.
    device.counter = 0;
    const second = await mfa.passkeyOptionsFor(m);
    if (!second) throw new Error("no options");
    expect(await mfa.verifyPasskey(m, second.challengeId, device.assert(second.options))).toBe(
      false,
    );
    device.counter = 5;
    const third = await mfa.passkeyOptionsFor(m);
    if (!third) throw new Error("no options");
    expect(await mfa.verifyPasskey(m, third.challengeId, device.assert(third.options))).toBe(true);
  });

  it("refuse an assertion replayed against a spent challenge, or signed for another origin", async () => {
    const m = await seedMember(pool);
    const { device } = await enrolPasskey(m);
    const options = await mfa.passkeyOptionsFor(m);
    if (!options) throw new Error("no options");
    const good = device.assert(options.options);
    expect(await mfa.verifyPasskey(m, options.challengeId, good)).toBe(true);
    expect(await mfa.verifyPasskey(m, options.challengeId, good)).toBe(false);
    const again = await mfa.passkeyOptionsFor(m);
    if (!again) throw new Error("no options");
    expect(
      await mfa.verifyPasskey(
        m,
        again.challengeId,
        device.assert(again.options, { origin: "https://evil.test" }),
      ),
    ).toBe(false);
  });

  it("refuse someone else's passkey for this person", async () => {
    const m = await seedMember(pool);
    const other = await addUser(m);
    const { device } = await enrolPasskey(other);
    await enrolPasskey(m);
    const options = await mfa.passkeyOptionsFor(m);
    if (!options) throw new Error("no options");
    expect(await mfa.verifyPasskey(m, options.challengeId, device.assert(options.options))).toBe(
      false,
    );
  });

  it("serve as the second factor after the password", async () => {
    const m = await seedMember(pool);
    const { device } = await enrolPasskey(m);
    const outcome = await loginOf(m);
    expect(outcome).toMatchObject({ kind: "challenge", methods: ["passkey", "recovery"] });
    if (outcome?.kind !== "challenge") throw new Error("expected a challenge");
    const pending = await mfa.pendingOf(outcome.mfaToken);
    if (!pending) throw new Error("no pending sign-in");
    const options = await mfa.passkeyOptionsFor(pending);
    if (!options) throw new Error("no options");
    const session = await mfa.completePasskey(
      pending,
      options.challengeId,
      device.assert(options.options),
      client,
    );
    expect(session?.principal.mfaAt).toBeInstanceOf(Date);
    const login = (await auditTrail(pool, m.workspaceId)).at(-1);
    expect(login?.details).toEqual({ method: "password+passkey" });
  });

  it("sign in on their own, passkey first, with no password", async () => {
    const m = await seedMember(pool);
    const { device } = await enrolPasskey(m);
    const options = await mfa.passkeyLoginOptions(m.slug);
    const session = await mfa.passkeyLogin(
      m.slug,
      options.challengeId,
      device.assert(options.options),
      client,
    );
    expect(session?.principal.userId).toBe(m.userId);
    expect(session?.principal.mfaAt).toBeInstanceOf(Date);
    expect((await auditTrail(pool, m.workspaceId)).at(-1)?.details).toEqual({ method: "passkey" });
  });

  it("do not sign in passkey-first for a suspended person, the wrong workspace or a stranger", async () => {
    const m = await seedMember(pool);
    const other = await seedMember(pool);
    const { device } = await enrolPasskey(m);
    // Wrong workspace slug: the credential is not found there.
    const wrongWs = await mfa.passkeyLoginOptions(other.slug);
    expect(
      await mfa.passkeyLogin(
        other.slug,
        wrongWs.challengeId,
        device.assert(wrongWs.options),
        client,
      ),
    ).toBeNull();
    // Unknown workspace gets options that look the same, and then fails.
    const nowhere = await mfa.passkeyLoginOptions("no-such-workspace");
    expect(nowhere.options.challenge).toBeTruthy();
    expect(
      await mfa.passkeyLogin(
        "no-such-workspace",
        nowhere.challengeId,
        device.assert(nowhere.options),
        client,
      ),
    ).toBeNull();
    // Suspended.
    await pool.query(`update core."user" set status = 'suspended' where id = $1`, [m.userId]);
    const options = await mfa.passkeyLoginOptions(m.slug);
    expect(
      await mfa.passkeyLogin(m.slug, options.challengeId, device.assert(options.options), client),
    ).toBeNull();
    expect((await auditTrail(pool, m.workspaceId)).at(-1)?.details).toMatchObject({
      reason: "not_active",
    });
  });

  it("leave only administrators their passkey once single sign-on is on", async () => {
    const signIn = async (permissions: string[]) => {
      const m = await seedMember(pool, { permissions });
      const { device } = await enrolPasskey(m);
      await pool.query(
        `insert into core.oidc_provider (workspace_id, issuer, client_id, enabled)
         values ($1, 'https://idp.test', 'x', true)`,
        [m.workspaceId],
      );
      const options = await mfa.passkeyLoginOptions(m.slug);
      return mfa.passkeyLogin(m.slug, options.challengeId, device.assert(options.options), client);
    };
    expect(await signIn(["threads.use"])).toBeNull();
    expect(await signIn(["*"])).not.toBeNull();
  });

  it("refuse a passkey-first assertion when the device skipped user verification", async () => {
    const m = await seedMember(pool);
    const { device } = await enrolPasskey(m);
    const lazy = createAuthenticator({ ...rp, userVerifies: false });
    const options = await mfa.passkeyLoginOptions(m.slug);
    expect(
      await mfa.passkeyLogin(m.slug, options.challengeId, lazy.assert(options.options), client),
    ).toBeNull();
    expect(device.credentialId).not.toBe(lazy.credentialId);
  });

  it("are removed by their owner, but not the last one under a policy that needs it", async () => {
    const m = await seedMember(pool);
    await enrolPasskey(m);
    await enrolPasskey(m);
    const [first, second] = (await mfa.status(m)).passkeys;
    expect(await mfa.removePasskey(m, first?.id ?? "", client)).toBe(true);
    await expect(mfa.removePasskey(m, second?.id ?? "", client)).rejects.toThrow(
      /cannot be removed/,
    );
    expect(await mfa.removePasskey(m, randomUUID(), client)).toBe(false);
  });

  it("cannot be removed by another person", async () => {
    const m = await seedMember(pool);
    const other = await addUser(m);
    await enrolPasskey(m);
    const [key] = (await mfa.status(m)).passkeys;
    expect(await mfa.removePasskey(other, key?.id ?? "", client)).toBe(false);
    expect((await mfa.status(m)).passkeys).toHaveLength(1);
  });
});
