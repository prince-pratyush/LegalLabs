import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type pg from "pg";
import { asApp, type Identity } from "../../db.js";
import { type Client, type Principal, SESSION_SECONDS, uaHash } from "../auth.js";
import { verifyPassword } from "../password.js";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normaliseRecoveryCode,
  RECOVERY_CODES,
} from "./recovery.js";
import { open, seal } from "./seal.js";
import type { MfaPolicy } from "./step-up.js";
import { base32Encode, generateSecret, matchCode, otpauthUri } from "./totp.js";

export interface MfaConfig {
  /** The domain passkeys are bound to, e.g. "legallabs.example". */
  rpID: string;
  rpName: string;
  /** Origins a passkey ceremony may run on, e.g. "https://legallabs.example". */
  origins: string[];
  /** 32 bytes sealing authenticator secrets. */
  encryptionKey: Buffer;
  now?: () => number;
}

export interface Subject {
  userId: string;
  workspaceId: string;
}

/** A password-verified sign-in waiting for its second factor. */
export interface Pending extends Subject {
  id: string;
  purpose: "verify" | "enrol";
}

export type Method = "totp" | "passkey" | "recovery";

export type LoginOutcome =
  | { kind: "session"; token: string; principal: Principal }
  | { kind: "challenge"; mfaToken: string; methods: Method[] }
  | { kind: "enrol"; mfaToken: string; methods: ("totp" | "passkey")[] };

export interface MfaStatus {
  policy: MfaPolicy;
  required: boolean;
  totp: boolean;
  passkeys: { id: string; name: string; createdAt: Date; lastUsedAt: Date | null }[];
  recoveryRemaining: number;
}

export interface PasskeyChallenge<T> {
  challengeId: string;
  options: T;
}

export type Enrolled = { ok: true; recoveryCodes: string[] | null } | { ok: false };

export class LastFactorError extends Error {
  constructor() {
    super("The workspace policy requires a second factor, so the last one cannot be removed.");
  }
}

const NOBODY: Identity = { userId: null, workspaceId: null };
const PENDING_SECONDS = 600;
const CHALLENGE_SECONDS = 300;

const sha256 = (text: string) => createHash("sha256").update(text).digest();

type Db = pg.PoolClient;

export function createMfa(pool: pg.Pool, config: MfaConfig) {
  const now = config.now ?? Date.now;
  const as = <T>(s: Subject, work: (db: Db) => Promise<T>) =>
    asApp(pool, { userId: s.userId, workspaceId: s.workspaceId }, work);
  const asNobody = <T>(work: (db: Db) => Promise<T>) => asApp(pool, NOBODY, work);
  // Binds a sealed secret to its owner.
  const context = (s: Subject) => `totp:${s.workspaceId}:${s.userId}`;

  const auditAs = (
    db: Db,
    s: Subject,
    client: Client,
    action: string,
    objectType: string,
    objectId: string,
    details: object = {},
  ) =>
    db.query("select admin.append_audit_event($1, 'user', $2, $3, $4, $5, $6, $7)", [
      action,
      s.userId,
      objectType,
      objectId,
      JSON.stringify(details),
      client.ip,
      uaHash(client),
    ]);

  // Before there is a session the failure is a system event, as with a bad password.
  const auditFailure = (
    workspaceId: string,
    userId: string | null,
    client: Client,
    details: object,
  ) =>
    asApp(pool, { userId: null, workspaceId }, (db) =>
      db.query(
        "select admin.append_audit_event('login.failure', 'system', null, $1, $2, $3, $4, $5)",
        [userId ? "user" : null, userId, JSON.stringify(details), client.ip, uaHash(client)],
      ),
    );

  async function stateOf(s: Subject) {
    const { rows } = await asNobody((db) =>
      db.query<{ policy: MfaPolicy; required: boolean; has_totp: boolean; has_passkey: boolean }>(
        "select * from core.mfa_login_state($1, $2)",
        [s.workspaceId, s.userId],
      ),
    );
    const r = rows[0];
    return {
      policy: r?.policy ?? "admins",
      required: r?.required ?? false,
      totp: r?.has_totp ?? false,
      passkey: r?.has_passkey ?? false,
    };
  }

  async function mintSession(
    s: Subject,
    client: Client,
    method: Method | "passkey_login" | null,
  ): Promise<{ token: string; principal: Principal }> {
    const token = randomBytes(32).toString("base64url");
    const principal = await as(s, async (db) => {
      const { rows } = await db.query<{ id: string; mfa_at: Date | null }>(
        `insert into core.session (workspace_id, user_id, token_hash, expires_at, ip, ua_hash, mfa_at)
         values ($1, $2, $3, now() + make_interval(secs => $4), $5, $6,
                 case when $7::text is null then null else now() end)
         returning id, mfa_at`,
        [
          s.workspaceId,
          s.userId,
          sha256(token),
          SESSION_SECONDS,
          client.ip,
          uaHash(client),
          method,
        ],
      );
      const row = rows[0];
      await auditAs(db, s, client, "login.success", "session", row?.id ?? "", {
        method:
          method === null
            ? "password"
            : method === "passkey_login"
              ? "passkey"
              : `password+${method}`,
      });
      return {
        sessionId: row?.id ?? "",
        userId: s.userId,
        workspaceId: s.workspaceId,
        mfaAt: row?.mfa_at ?? null,
      };
    });
    return { token, principal };
  }

  // ---- password step -------------------------------------------------------------------------

  async function login(
    attempt: { workspace: string; email: string; password: string },
    client: Client,
  ): Promise<LoginOutcome | null> {
    const row = await asNobody(async (db) => {
      const { rows } = await db.query<{
        workspace_id: string;
        user_id: string | null;
        status: string | null;
        password_hash: string | null;
      }>("select * from core.find_login_credential($1, $2)", [attempt.workspace, attempt.email]);
      return rows[0];
    });
    const matches = await verifyPassword(row?.password_hash ?? null, attempt.password);
    if (!row) return null;
    const reason = !row.user_id
      ? "unknown_user"
      : !row.password_hash
        ? "no_password"
        : !matches
          ? "bad_password"
          : row.status !== "active"
            ? "not_active"
            : null;
    if (reason !== null || !row.user_id) {
      await auditFailure(row.workspace_id, row.user_id, client, { reason });
      return null;
    }

    const subject = { userId: row.user_id, workspaceId: row.workspace_id };
    const state = await stateOf(subject);
    const hasFactor = state.totp || state.passkey;
    // A factor someone enrolled is honoured even where the policy does not demand one.
    if (!state.required && !hasFactor)
      return { kind: "session", ...(await mintSession(subject, client, null)) };

    const mfaToken = randomBytes(32).toString("base64url");
    await as(subject, async (db) => {
      await db.query("select core.mfa_pending_create($1, $2, $3)", [
        hasFactor ? "verify" : "enrol",
        sha256(mfaToken),
        PENDING_SECONDS,
      ]);
      await auditAs(db, subject, client, "login.mfa_challenge", "user", subject.userId, {
        reason: hasFactor ? "second_factor" : "enrolment_required",
      });
    });
    if (!hasFactor) return { kind: "enrol", mfaToken, methods: ["totp", "passkey"] };
    const methods: Method[] = [];
    if (state.totp) methods.push("totp");
    if (state.passkey) methods.push("passkey");
    methods.push("recovery");
    return { kind: "challenge", mfaToken, methods };
  }

  async function pendingOf(mfaToken: string): Promise<Pending | null> {
    const { rows } = await asNobody((db) =>
      db.query<{ id: string; workspace_id: string; user_id: string; purpose: "verify" | "enrol" }>(
        "select * from core.mfa_pending_resolve($1)",
        [sha256(mfaToken)],
      ),
    );
    const r = rows[0];
    return r
      ? { id: r.id, workspaceId: r.workspace_id, userId: r.user_id, purpose: r.purpose }
      : null;
  }

  /** Records a wrong second factor against the pending sign-in; five retire it. */
  async function strike(p: Pending, client: Client, method: Method) {
    await asNobody((db) => db.query("select core.mfa_pending_strike($1)", [p.id]));
    await auditFailure(p.workspaceId, p.userId, client, { reason: `bad_${method}`, method });
  }

  /** Turns a satisfied pending sign-in into a session, once. */
  async function finish(
    p: Pending,
    method: Method,
    client: Client,
  ): Promise<{ token: string; principal: Principal } | null> {
    const { rows } = await asNobody((db) =>
      db.query<{ ok: boolean }>("select core.mfa_pending_consume($1) as ok", [p.id]),
    );
    if (!rows[0]?.ok) return null;
    return mintSession(p, client, method);
  }

  // ---- factor checks, shared by sign-in and step-up ------------------------------------------

  async function verifyTotp(s: Subject, code: string): Promise<boolean> {
    return as(s, async (db) => {
      const { rows } = await db.query<{ secret_enc: Buffer; confirmed: boolean }>(
        "select secret_enc, confirmed from core.mfa_totp_get()",
      );
      const r = rows[0];
      if (!r?.confirmed) return false;
      const secret = open(config.encryptionKey, r.secret_enc, context(s));
      const step = secret ? matchCode(secret, code, now()) : null;
      if (step === null) return false;
      const accepted = await db.query<{ ok: boolean }>(
        "select core.mfa_totp_accept($1, false) as ok",
        [step],
      );
      return accepted.rows[0]?.ok === true;
    });
  }

  async function verifyRecovery(s: Subject, code: string): Promise<boolean> {
    if (normaliseRecoveryCode(code).length !== 16) return false;
    return as(s, async (db) => {
      const { rows } = await db.query<{ ok: boolean }>(
        "select core.mfa_recovery_consume($1) as ok",
        [hashRecoveryCode(code)],
      );
      return rows[0]?.ok === true;
    });
  }

  async function challengeFor(
    db: Db,
    purpose: "register" | "authenticate",
    workspaceId: string,
    userId: string | null,
    challenge: string,
  ) {
    const { rows } = await db.query<{ id: string }>(
      "select core.mfa_challenge_put($1, $2, $3, $4, $5) as id",
      [purpose, workspaceId, userId, challenge, CHALLENGE_SECONDS],
    );
    return rows[0]?.id ?? "";
  }

  async function takeChallenge(
    db: Db,
    purpose: "register" | "authenticate",
    challengeId: string,
  ): Promise<{ workspace_id: string; user_id: string | null; challenge: string } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(challengeId)) return null;
    const { rows } = await db.query<{
      workspace_id: string;
      user_id: string | null;
      challenge: string;
    }>("select * from core.mfa_challenge_take($1, $2)", [challengeId, purpose]);
    return rows[0] ?? null;
  }

  async function passkeyOptions(
    s: Subject,
  ): Promise<PasskeyChallenge<PublicKeyCredentialRequestOptionsJSON> | null> {
    const keys = await as(s, async (db) => {
      const { rows } = await db.query<{ credential_id: string; transports: string[] }>(
        "select credential_id, transports from core.mfa_passkey_list()",
      );
      return rows;
    });
    if (keys.length === 0) return null;
    const options = await generateAuthenticationOptions({
      rpID: config.rpID,
      allowCredentials: keys.map((k) => ({ id: k.credential_id, transports: k.transports })),
      userVerification: "required",
    });
    const challengeId = await as(s, (db) =>
      challengeFor(db, "authenticate", s.workspaceId, s.userId, options.challenge),
    );
    return { challengeId, options };
  }

  async function assertion(
    stored: { publicKey: Buffer; counter: number; transports: string[] },
    expectedChallenge: string,
    response: AuthenticationResponseJSON,
  ): Promise<number | null> {
    try {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: config.origins,
        expectedRPID: config.rpID,
        requireUserVerification: true,
        credential: {
          id: response.id,
          publicKey: new Uint8Array(stored.publicKey),
          counter: stored.counter,
          transports: stored.transports,
        },
      });
      return result.verified ? result.authenticationInfo.newCounter : null;
    } catch {
      return null;
    }
  }

  async function verifyPasskey(
    s: Subject,
    challengeId: string,
    response: AuthenticationResponseJSON,
  ): Promise<boolean> {
    return as(s, async (db) => {
      const taken = await takeChallenge(db, "authenticate", challengeId);
      if (!taken || taken.user_id !== s.userId || taken.workspace_id !== s.workspaceId)
        return false;
      const { rows } = await db.query<{
        id: string;
        public_key: Buffer;
        counter: string;
        transports: string[];
      }>("select * from core.mfa_passkey_get($1)", [response.id]);
      const key = rows[0];
      if (!key) return false;
      const counter = await assertion(
        { publicKey: key.public_key, counter: Number(key.counter), transports: key.transports },
        taken.challenge,
        response,
      );
      if (counter === null) return false;
      const touched = await db.query<{ ok: boolean }>(
        "select core.mfa_passkey_touch($1, $2) as ok",
        [key.id, counter],
      );
      return touched.rows[0]?.ok === true;
    });
  }

  // ---- second step of sign-in ----------------------------------------------------------------

  async function completeWith(
    p: Pending,
    method: Method,
    ok: boolean,
    client: Client,
  ): Promise<{ token: string; principal: Principal } | null> {
    if (p.purpose !== "verify") return null;
    if (!ok) {
      await strike(p, client, method);
      return null;
    }
    return finish(p, method, client);
  }

  // ---- passkey-first sign-in -----------------------------------------------------------------

  async function passkeyLoginOptions(
    workspaceSlug: string,
  ): Promise<PasskeyChallenge<PublicKeyCredentialRequestOptionsJSON>> {
    const options = await generateAuthenticationOptions({
      rpID: config.rpID,
      userVerification: "required",
    });
    const workspaceId = await asNobody(async (db) => {
      // Reuses the login lookup, which names a workspace without needing a person.
      const { rows } = await db.query<{ workspace_id: string }>(
        "select workspace_id from core.find_login_credential($1, '')",
        [workspaceSlug],
      );
      return rows[0]?.workspace_id ?? null;
    });
    // An unknown workspace gets the same-looking answer, so the endpoint doesn't list tenants.
    if (!workspaceId) return { challengeId: randomUUID(), options };
    const challengeId = await asNobody((db) =>
      challengeFor(db, "authenticate", workspaceId, null, options.challenge),
    );
    return { challengeId, options };
  }

  async function passkeyLogin(
    workspaceSlug: string,
    challengeId: string,
    response: AuthenticationResponseJSON,
    client: Client,
  ): Promise<{ token: string; principal: Principal } | null> {
    const taken = await asNobody((db) => takeChallenge(db, "authenticate", challengeId));
    if (!taken || taken.user_id !== null) return null;
    const found = await asNobody(async (db) => {
      const { rows } = await db.query<{
        id: string;
        workspace_id: string;
        user_id: string;
        public_key: Buffer;
        counter: string;
        transports: string[];
        status: string;
        kind: string;
      }>("select * from core.mfa_passkey_lookup($1, $2)", [workspaceSlug, response.id]);
      return rows[0];
    });
    if (!found || found.workspace_id !== taken.workspace_id) return null;
    const subject = { userId: found.user_id, workspaceId: found.workspace_id };
    const counter = await assertion(
      { publicKey: found.public_key, counter: Number(found.counter), transports: found.transports },
      taken.challenge,
      response,
    );
    // The handle, when the device sends one, must name the same person as the credential.
    const handle = response.response.userHandle;
    const handleOk =
      handle === undefined || Buffer.from(handle, "base64url").toString() === subject.userId;
    if (counter === null || !handleOk) {
      await auditFailure(subject.workspaceId, subject.userId, client, {
        reason: "bad_passkey",
        method: "passkey",
      });
      return null;
    }
    if (found.status !== "active" || found.kind !== "member") {
      await auditFailure(subject.workspaceId, subject.userId, client, { reason: "not_active" });
      return null;
    }
    const touched = await as(subject, async (db) => {
      const { rows } = await db.query<{ ok: boolean }>(
        "select core.mfa_passkey_touch($1, $2) as ok",
        [found.id, counter],
      );
      return rows[0]?.ok === true;
    });
    if (!touched) return null;
    // A passkey with user verification is possession plus a PIN or biometric, so it stands alone.
    return mintSession(subject, client, "passkey_login");
  }

  // ---- enrolment -----------------------------------------------------------------------------

  async function emailOf(db: Db, s: Subject): Promise<string> {
    const { rows } = await db.query<{ email: string }>(
      `select email from core."user" where id = $1 and workspace_id = $2`,
      [s.userId, s.workspaceId],
    );
    return rows[0]?.email ?? "";
  }

  async function totpBegin(s: Subject): Promise<{ secret: string; uri: string } | null> {
    return as(s, async (db) => {
      const secret = generateSecret();
      try {
        await db.query("select core.mfa_totp_begin($1)", [
          seal(config.encryptionKey, secret, context(s)),
        ]);
      } catch (err) {
        if ((err as { code?: string }).code === "23505") return null;
        throw err;
      }
      return {
        secret: base32Encode(secret),
        uri: otpauthUri(secret, await emailOf(db, s), config.rpName),
      };
    });
  }

  // Recovery codes come with the first factor, and are shown only in that response.
  async function issueRecoveryIfNone(db: Db, s: Subject): Promise<string[] | null> {
    const { rows } = await db.query<{ recovery_remaining: number }>(
      "select recovery_remaining from core.mfa_summary($1)",
      [s.userId],
    );
    if ((rows[0]?.recovery_remaining ?? 0) > 0) return null;
    return replaceRecovery(db);
  }

  async function replaceRecovery(db: Db): Promise<string[]> {
    const codes = generateRecoveryCodes(RECOVERY_CODES);
    await db.query("select core.mfa_recovery_replace($1)", [codes.map(hashRecoveryCode)]);
    return codes;
  }

  async function totpConfirm(s: Subject, code: string, client: Client): Promise<Enrolled> {
    return as(s, async (db) => {
      const { rows } = await db.query<{ secret_enc: Buffer; confirmed: boolean }>(
        "select secret_enc, confirmed from core.mfa_totp_get()",
      );
      const r = rows[0];
      if (!r || r.confirmed) return { ok: false };
      const secret = open(config.encryptionKey, r.secret_enc, context(s));
      const step = secret ? matchCode(secret, code, now()) : null;
      if (step === null) return { ok: false };
      const accepted = await db.query<{ ok: boolean }>(
        "select core.mfa_totp_accept($1, true) as ok",
        [step],
      );
      if (accepted.rows[0]?.ok !== true) return { ok: false };
      await auditAs(db, s, client, "mfa.enrolled", "user", s.userId, { factor: "totp" });
      return { ok: true, recoveryCodes: await issueRecoveryIfNone(db, s) };
    });
  }

  async function passkeyRegisterOptions(
    s: Subject,
  ): Promise<PasskeyChallenge<PublicKeyCredentialCreationOptionsJSON>> {
    return as(s, async (db) => {
      const { rows } = await db.query<{ credential_id: string; transports: string[] }>(
        "select credential_id, transports from core.mfa_passkey_list()",
      );
      const options = await generateRegistrationOptions({
        rpName: config.rpName,
        rpID: config.rpID,
        userName: await emailOf(db, s),
        userID: new TextEncoder().encode(s.userId),
        attestationType: "none",
        excludeCredentials: rows.map((k) => ({ id: k.credential_id, transports: k.transports })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      });
      return {
        challengeId: await challengeFor(db, "register", s.workspaceId, s.userId, options.challenge),
        options,
      };
    });
  }

  async function passkeyRegisterVerify(
    s: Subject,
    challengeId: string,
    response: RegistrationResponseJSON,
    name: string,
    client: Client,
  ): Promise<Enrolled> {
    return as(s, async (db) => {
      const taken = await takeChallenge(db, "register", challengeId);
      if (!taken || taken.user_id !== s.userId || taken.workspace_id !== s.workspaceId) {
        return { ok: false };
      }
      let info: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        info = await verifyRegistrationResponse({
          response,
          expectedChallenge: taken.challenge,
          expectedOrigin: config.origins,
          expectedRPID: config.rpID,
          requireUserVerification: true,
        });
      } catch {
        return { ok: false };
      }
      if (!info.verified) return { ok: false };
      const { credential, credentialDeviceType, credentialBackedUp } = info.registrationInfo;
      try {
        await db.query("select core.mfa_passkey_add($1, $2, $3, $4, $5, $6, $7)", [
          credential.id,
          Buffer.from(credential.publicKey),
          credential.counter,
          credential.transports ?? [],
          name,
          credentialDeviceType,
          credentialBackedUp,
        ]);
      } catch (err) {
        // The same authenticator twice: Postgres aborts the transaction, so end it here.
        if ((err as { code?: string }).code === "23505") return { ok: false };
        throw err;
      }
      await auditAs(db, s, client, "mfa.enrolled", "user", s.userId, { factor: "passkey" });
      return { ok: true, recoveryCodes: await issueRecoveryIfNone(db, s) };
    });
  }

  // ---- management ----------------------------------------------------------------------------

  async function status(s: Subject): Promise<MfaStatus> {
    const state = await stateOf(s);
    return as(s, async (db) => {
      const keys = await db.query<{
        id: string;
        name: string;
        created_at: Date;
        last_used_at: Date | null;
      }>("select id, name, created_at, last_used_at from core.mfa_passkey_list()");
      const summary = await db.query<{ recovery_remaining: number }>(
        "select recovery_remaining from core.mfa_summary($1)",
        [s.userId],
      );
      return {
        policy: state.policy,
        required: state.required,
        totp: state.totp,
        passkeys: keys.rows.map((k) => ({
          id: k.id,
          name: k.name,
          createdAt: k.created_at,
          lastUsedAt: k.last_used_at,
        })),
        recoveryRemaining: summary.rows[0]?.recovery_remaining ?? 0,
      };
    });
  }

  // Run inside the removal's transaction, so refusing rolls the removal back.
  async function afterRemoval(db: Db, s: Subject) {
    const { rows } = await db.query<{ required: boolean; has_totp: boolean; has_passkey: boolean }>(
      "select required, has_totp, has_passkey from core.mfa_login_state($1, $2)",
      [s.workspaceId, s.userId],
    );
    const r = rows[0];
    if (r && !r.has_totp && !r.has_passkey) {
      if (r.required) throw new LastFactorError();
      await db.query("select core.mfa_recovery_clear()");
    }
  }

  async function removeTotp(s: Subject, client: Client): Promise<boolean> {
    return as(s, async (db) => {
      const { rows } = await db.query<{ ok: boolean }>("select core.mfa_totp_delete() as ok");
      if (rows[0]?.ok !== true) return false;
      await auditAs(db, s, client, "mfa.removed", "user", s.userId, { factor: "totp", by: "self" });
      await afterRemoval(db, s);
      return true;
    });
  }

  async function removePasskey(s: Subject, id: string, client: Client): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    return as(s, async (db) => {
      const { rows } = await db.query<{ ok: boolean }>("select core.mfa_passkey_remove($1) as ok", [
        id,
      ]);
      if (rows[0]?.ok !== true) return false;
      await auditAs(db, s, client, "mfa.removed", "user", s.userId, {
        factor: "passkey",
        by: "self",
      });
      await afterRemoval(db, s);
      return true;
    });
  }

  async function regenerateRecovery(s: Subject, client: Client): Promise<string[]> {
    return as(s, async (db) => {
      const codes = await replaceRecovery(db);
      await auditAs(db, s, client, "mfa.enrolled", "user", s.userId, { factor: "recovery_codes" });
      return codes;
    });
  }

  /** Records that this session just showed a factor, which opens the step-up window. */
  async function markFresh(p: Principal, client: Client, method: Method): Promise<Date | null> {
    return as(p, async (db) => {
      const { rows } = await db.query<{ at: Date | null }>(
        "select core.mfa_session_touch($1) as at",
        [p.sessionId],
      );
      const at = rows[0]?.at;
      if (!at) return null;
      await auditAs(db, p, client, "mfa.verified", "session", p.sessionId, { method });
      return at;
    });
  }

  /** Whether this person has any factor; a person with none cannot be asked for a fresh one. */
  async function hasFactor(s: Subject): Promise<boolean> {
    const state = await stateOf(s);
    return state.totp || state.passkey;
  }

  // ---- admin ---------------------------------------------------------------------------------

  async function resetUser(
    admin: Principal,
    targetId: string,
    client: Client,
  ): Promise<{ ok: true; removed: number } | { ok: false }> {
    if (!/^[0-9a-f-]{36}$/i.test(targetId)) return { ok: false };
    try {
      return await as(admin, async (db) => {
        const { rows } = await db.query<{ removed: number }>(
          "select core.mfa_reset_user($1) as removed",
          [targetId],
        );
        // Their open sessions go too, so the reset takes effect at once.
        await db.query(
          "update core.session set revoked_at = now() where user_id = $1 and revoked_at is null",
          [targetId],
        );
        const removed = rows[0]?.removed ?? 0;
        await auditAs(db, admin, client, "mfa.reset", "user", targetId, { removed });
        return { ok: true as const, removed };
      });
    } catch (err) {
      if ((err as { code?: string }).code === "42501") return { ok: false };
      throw err;
    }
  }

  async function setPolicy(admin: Principal, policy: MfaPolicy, client: Client): Promise<boolean> {
    return as(admin, async (db) => {
      const before = await db.query<{ policy: string | null }>(
        "select settings ->> 'mfa' as policy from core.workspace where id = $1",
        [admin.workspaceId],
      );
      const { rowCount } = await db.query(
        `update core.workspace set settings = jsonb_set(settings, '{mfa}', to_jsonb($1::text))
          where id = $2`,
        [policy, admin.workspaceId],
      );
      // The workspace policy only lets an admin.config holder through, so zero rows is a refusal.
      if (rowCount === 0) return false;
      await auditAs(db, admin, client, "mfa.policy_changed", "workspace", admin.workspaceId, {
        from: before.rows[0]?.policy ?? "admins",
        to: policy,
      });
      return true;
    });
  }

  async function summaryOf(admin: Principal, targetId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(targetId)) return null;
    return as(admin, async (db) => {
      const { rows } = await db.query<{
        has_totp: boolean;
        passkeys: number;
        recovery_remaining: number;
      }>("select * from core.mfa_summary($1)", [targetId]);
      return rows[0] ?? null;
    });
  }

  return {
    login,
    pendingOf,
    completeTotp: async (p: Pending, code: string, client: Client) =>
      completeWith(p, "totp", await verifyTotp(p, code), client),
    completeRecovery: async (p: Pending, code: string, client: Client) =>
      completeWith(p, "recovery", await verifyRecovery(p, code), client),
    passkeyOptionsFor: passkeyOptions,
    completePasskey: async (
      p: Pending,
      challengeId: string,
      response: AuthenticationResponseJSON,
      client: Client,
    ) =>
      completeWith(
        p,
        "passkey",
        p.purpose === "verify" && (await verifyPasskey(p, challengeId, response)),
        client,
      ),
    /** Mints the session once enrolment under an 'enrol' pending sign-in has produced a factor. */
    finishEnrolment: async (p: Pending, method: "totp" | "passkey", client: Client) =>
      p.purpose === "enrol" ? finish(p, method, client) : null,
    strike,
    passkeyLoginOptions,
    passkeyLogin,
    totpBegin,
    totpConfirm,
    passkeyRegisterOptions,
    passkeyRegisterVerify,
    verifyTotp,
    verifyRecovery,
    verifyPasskey,
    removeTotp,
    removePasskey,
    regenerateRecovery,
    markFresh,
    hasFactor,
    status,
    resetUser,
    setPolicy,
    summaryOf,
  };
}

export type Mfa = ReturnType<typeof createMfa>;
