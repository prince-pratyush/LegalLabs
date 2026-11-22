import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth.js";
import { createLimiter } from "../limiter.js";
import { MAX_PASSWORD_LENGTH } from "../password.js";
import { LastFactorError, type Mfa, type Pending } from "./service.js";
import { FRESH_MFA_MS, hasFreshMfa, POLICIES } from "./step-up.js";

export interface MfaRouteOptions {
  mfa: Mfa;
  clientOf: (c: Context) => Client;
  clientIp: (c: Context) => string | null;
  /** Sets the session cookie, ending any session the browser already held. */
  startSession: (c: Context, token: string) => Promise<void>;
  now?: () => number;
}

const text = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((t) => !t.includes("\0"), "Postgres text cannot hold a NUL byte");

const loginBody = z.object({
  workspace: text(1, 63),
  email: text(3, 320),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});
const tokenBody = z.object({ mfa_token: text(20, 100) });
const codeBody = z.object({ code: text(6, 40) });
const pendingCode = tokenBody.extend(codeBody.shape);
// Browser ceremonies are plain JSON; the library checks their contents, we only bound their size.
const credential = z.record(z.string(), z.unknown());
const passkeyBody = z.object({ challenge_id: text(36, 36), response: credential });
const registerBody = passkeyBody.extend({ name: text(1, 100).optional() });

const FORBIDDEN = { code: "FORBIDDEN", message: "You do not have permission to do that." };
const mfaRequired = {
  code: "MFA_REQUIRED",
  message: "Confirm with your second factor to continue.",
};
const BAD_TOKEN = { error: "invalid_mfa_token" };

const readJson = async <T extends z.ZodType>(c: Context, schema: T) => {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
};

/** Sign-in endpoints: reachable without a session, mounted under /auth. */
export function mfaAuthRoutes(opts: MfaRouteOptions) {
  const { mfa, clientOf, clientIp, startSession, now = Date.now } = opts;
  const app = new Hono();
  const body = bodyLimit({ maxSize: 32 * 1024 });
  const perIp = createLimiter({ limit: 10, windowMs: 60_000, now });
  const perAccount = createLimiter({ limit: 5, windowMs: 60_000, now });
  // Factor guesses are also capped per sign-in in the database; this one is per caller.
  const factorsPerIp = createLimiter({ limit: 30, windowMs: 60_000, now });

  const limited = (c: Context, wait: number) => {
    if (wait === 0) return null;
    c.header("Retry-After", String(wait));
    return c.json({ error: "too_many_attempts" }, 429);
  };

  const sessionReply = async (
    c: Context,
    result: { token: string; principal: Principal },
    extra: object = {},
  ) => {
    await startSession(c, result.token);
    return c.json({
      user_id: result.principal.userId,
      workspace_id: result.principal.workspaceId,
      ...extra,
    });
  };

  // Resolves the pending sign-in a request names, after the per-caller limit.
  const withPending = async (
    c: Context,
    token: string,
    run: (p: Pending) => Promise<Response>,
  ): Promise<Response> => {
    const wait = factorsPerIp.take(clientIp(c) ?? "unknown");
    const refused = limited(c, wait);
    if (refused) return refused;
    const pending = await mfa.pendingOf(token);
    if (!pending) return c.json(BAD_TOKEN, 401);
    return run(pending);
  };

  const wrong = (c: Context) => c.json({ error: "invalid_code" }, 401);

  app.post("/login", body, async (c) => {
    const parsed = await readJson(c, loginBody);
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    const refused = limited(
      c,
      perIp.take(clientIp(c) ?? "unknown") ||
        perAccount.take(`${parsed.workspace}|${parsed.email}`.toLowerCase()),
    );
    if (refused) return refused;

    const outcome = await mfa.login(parsed, clientOf(c));
    if (!outcome) return c.json({ error: "invalid_credentials" }, 401);
    if (outcome.kind === "session") return sessionReply(c, outcome);
    // Not a session: the caller holds a token good only for the second step.
    return c.json({
      mfa_required: outcome.kind === "challenge",
      mfa_enrolment_required: outcome.kind === "enrol",
      mfa_token: outcome.mfaToken,
      methods: outcome.methods,
    });
  });

  app.post("/mfa/totp", body, async (c) => {
    const parsed = await readJson(c, pendingCode);
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    return withPending(c, parsed.mfa_token, async (p) => {
      const result = await mfa.completeTotp(p, parsed.code, clientOf(c));
      return result ? sessionReply(c, result) : wrong(c);
    });
  });

  app.post("/mfa/recovery", body, async (c) => {
    const parsed = await readJson(c, pendingCode);
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    return withPending(c, parsed.mfa_token, async (p) => {
      const result = await mfa.completeRecovery(p, parsed.code, clientOf(c));
      return result ? sessionReply(c, result) : wrong(c);
    });
  });

  app.post("/mfa/passkey/options", body, async (c) => {
    const parsed = await readJson(c, tokenBody);
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    return withPending(c, parsed.mfa_token, async (p) => {
      const challenge = p.purpose === "verify" ? await mfa.passkeyOptionsFor(p) : null;
      return challenge
        ? c.json({ challenge_id: challenge.challengeId, options: challenge.options })
        : c.json({ error: "no_passkey" }, 409);
    });
  });

  app.post("/mfa/passkey/verify", body, async (c) => {
    const parsed = await readJson(c, tokenBody.extend(passkeyBody.shape));
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    return withPending(c, parsed.mfa_token, async (p) => {
      const result = await mfa.completePasskey(
        p,
        parsed.challenge_id,
        parsed.response as unknown as AuthenticationResponseJSON,
        clientOf(c),
      );
      return result ? sessionReply(c, result) : wrong(c);
    });
  });

  // Enrolment before a session exists, for a person the policy covers who has no factor yet.
  const enrolling = (c: Context, token: string, run: (p: Pending) => Promise<Response>) =>
    withPending(c, token, (p) =>
      p.purpose === "enrol" ? run(p) : Promise.resolve(c.json(FORBIDDEN, 403)),
    );

  app.post("/mfa/enrol/totp/begin", body, async (c) => {
    const parsed = await readJson(c, tokenBody);
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    return enrolling(c, parsed.mfa_token, async (p) => {
      const begun = await mfa.totpBegin(p);
      return begun ? c.json(begun) : c.json({ error: "already_enrolled" }, 409);
    });
  });

  app.post("/mfa/enrol/totp/confirm", body, async (c) => {
    const parsed = await readJson(c, pendingCode);
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    return enrolling(c, parsed.mfa_token, async (p) => {
      const enrolled = await mfa.totpConfirm(p, parsed.code, clientOf(c));
      if (!enrolled.ok) {
        await mfa.strike(p, clientOf(c), "totp");
        return wrong(c);
      }
      const session = await mfa.finishEnrolment(p, "totp", clientOf(c));
      return session
        ? sessionReply(c, session, { recovery_codes: enrolled.recoveryCodes })
        : c.json(BAD_TOKEN, 401);
    });
  });

  app.post("/mfa/enrol/passkey/options", body, async (c) => {
    const parsed = await readJson(c, tokenBody);
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    return enrolling(c, parsed.mfa_token, async (p) => {
      const challenge = await mfa.passkeyRegisterOptions(p);
      return c.json({ challenge_id: challenge.challengeId, options: challenge.options });
    });
  });

  app.post("/mfa/enrol/passkey/verify", body, async (c) => {
    const parsed = await readJson(c, tokenBody.extend(registerBody.shape));
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    return enrolling(c, parsed.mfa_token, async (p) => {
      const enrolled = await mfa.passkeyRegisterVerify(
        p,
        parsed.challenge_id,
        parsed.response as unknown as RegistrationResponseJSON,
        parsed.name ?? "Passkey",
        clientOf(c),
      );
      if (!enrolled.ok) {
        await mfa.strike(p, clientOf(c), "passkey");
        return wrong(c);
      }
      const session = await mfa.finishEnrolment(p, "passkey", clientOf(c));
      return session
        ? sessionReply(c, session, { recovery_codes: enrolled.recoveryCodes })
        : c.json(BAD_TOKEN, 401);
    });
  });

  // Passkey-first: no password and no mfa_token, just the workspace and the assertion.
  app.post("/passkey/options", body, async (c) => {
    const parsed = await readJson(c, z.object({ workspace: text(1, 63) }));
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    const refused = limited(c, perIp.take(clientIp(c) ?? "unknown"));
    if (refused) return refused;
    const challenge = await mfa.passkeyLoginOptions(parsed.workspace);
    return c.json({ challenge_id: challenge.challengeId, options: challenge.options });
  });

  app.post("/passkey/verify", body, async (c) => {
    const parsed = await readJson(c, passkeyBody.extend({ workspace: text(1, 63) }));
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    const refused = limited(c, factorsPerIp.take(clientIp(c) ?? "unknown"));
    if (refused) return refused;
    const result = await mfa.passkeyLogin(
      parsed.workspace,
      parsed.challenge_id,
      parsed.response as unknown as AuthenticationResponseJSON,
      clientOf(c),
    );
    return result ? sessionReply(c, result) : c.json({ error: "invalid_credentials" }, 401);
  });

  return app;
}

/** Managing your own factors, step-up, and the admin switches; mounted under /api/v1/mfa. */
export function mfaApiRoutes(opts: Pick<MfaRouteOptions, "mfa" | "clientOf" | "now">) {
  const { mfa, clientOf, now = Date.now } = opts;
  const app = new Hono<{ Variables: { principal: Principal } }>();
  const body = bodyLimit({ maxSize: 32 * 1024 });
  // Per person, so a stolen session can't guess codes any faster than the owner could type them.
  const perUser = createLimiter({ limit: 10, windowMs: 60_000, now });

  const throttled = (c: Context, p: Principal) => {
    const wait = perUser.take(p.userId);
    if (wait === 0) return null;
    c.header("Retry-After", String(wait));
    return c.json({ error: "too_many_attempts" }, 429);
  };

  // People with no factor cannot be asked for one: the policy has already decided their access.
  const needsStepUp = async (p: Principal) =>
    !hasFreshMfa(p, FRESH_MFA_MS, now()) && (await mfa.hasFactor(p));

  app.get("/", async (c) => {
    const p = c.get("principal");
    const status = await mfa.status(p);
    return c.json({
      policy: status.policy,
      required: status.required,
      totp: status.totp,
      passkeys: status.passkeys.map((k) => ({
        id: k.id,
        name: k.name,
        created_at: k.createdAt,
        last_used_at: k.lastUsedAt,
      })),
      recovery_remaining: status.recoveryRemaining,
      mfa_at: p.mfaAt ?? null,
    });
  });

  // ---- step-up ----
  const stepUp = async (c: Context, method: "totp" | "recovery" | "passkey", ok: boolean) => {
    const p = c.get("principal") as Principal;
    if (!ok) return c.json({ error: "invalid_code" }, 401);
    const at = await mfa.markFresh(p, clientOf(c), method);
    return at ? c.json({ mfa_at: at }) : c.json({ error: "unauthenticated" }, 401);
  };

  app.post("/step-up/totp", body, async (c) => {
    const p = c.get("principal");
    const parsed = await readJson(c, codeBody);
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    return throttled(c, p) ?? stepUp(c, "totp", await mfa.verifyTotp(p, parsed.code));
  });

  app.post("/step-up/recovery", body, async (c) => {
    const p = c.get("principal");
    const parsed = await readJson(c, codeBody);
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    return throttled(c, p) ?? stepUp(c, "recovery", await mfa.verifyRecovery(p, parsed.code));
  });

  app.post("/step-up/passkey/options", async (c) => {
    const p = c.get("principal");
    const challenge = await mfa.passkeyOptionsFor(p);
    return challenge
      ? c.json({ challenge_id: challenge.challengeId, options: challenge.options })
      : c.json({ error: "no_passkey" }, 409);
  });

  app.post("/step-up/passkey/verify", body, async (c) => {
    const p = c.get("principal");
    const parsed = await readJson(c, passkeyBody);
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    const refused = throttled(c, p);
    if (refused) return refused;
    const ok = await mfa.verifyPasskey(
      p,
      parsed.challenge_id,
      parsed.response as unknown as AuthenticationResponseJSON,
    );
    return stepUp(c, "passkey", ok);
  });

  // ---- authenticator app ----
  // Adding a factor to an account that already has one is a takeover route, so it needs step-up.
  app.post("/totp/begin", async (c) => {
    const p = c.get("principal");
    if (await needsStepUp(p)) return c.json(mfaRequired, 403);
    const begun = await mfa.totpBegin(p);
    return begun ? c.json(begun) : c.json({ error: "already_enrolled" }, 409);
  });

  app.post("/totp/confirm", body, async (c) => {
    const p = c.get("principal");
    const parsed = await readJson(c, codeBody);
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    const refused = throttled(c, p);
    if (refused) return refused;
    const enrolled = await mfa.totpConfirm(p, parsed.code, clientOf(c));
    return enrolled.ok
      ? c.json({ recovery_codes: enrolled.recoveryCodes })
      : c.json({ error: "invalid_code" }, 401);
  });

  app.delete("/totp", async (c) => {
    const p = c.get("principal");
    if (await needsStepUp(p)) return c.json(mfaRequired, 403);
    try {
      return (await mfa.removeTotp(p, clientOf(c)))
        ? c.body(null, 204)
        : c.json({ error: "not_found" }, 404);
    } catch (err) {
      if (err instanceof LastFactorError) return c.json({ error: "last_factor" }, 409);
      throw err;
    }
  });

  // ---- passkeys ----
  app.post("/passkeys/options", async (c) => {
    const p = c.get("principal");
    if (await needsStepUp(p)) return c.json(mfaRequired, 403);
    const challenge = await mfa.passkeyRegisterOptions(p);
    return c.json({ challenge_id: challenge.challengeId, options: challenge.options });
  });

  app.post("/passkeys/verify", body, async (c) => {
    const p = c.get("principal");
    const parsed = await readJson(c, registerBody);
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    const refused = throttled(c, p);
    if (refused) return refused;
    const enrolled = await mfa.passkeyRegisterVerify(
      p,
      parsed.challenge_id,
      parsed.response as unknown as RegistrationResponseJSON,
      parsed.name ?? "Passkey",
      clientOf(c),
    );
    return enrolled.ok
      ? c.json({ recovery_codes: enrolled.recoveryCodes })
      : c.json({ error: "invalid_passkey" }, 400);
  });

  app.delete("/passkeys/:id", async (c) => {
    const p = c.get("principal");
    if (await needsStepUp(p)) return c.json(mfaRequired, 403);
    try {
      return (await mfa.removePasskey(p, c.req.param("id"), clientOf(c)))
        ? c.body(null, 204)
        : c.json({ error: "not_found" }, 404);
    } catch (err) {
      if (err instanceof LastFactorError) return c.json({ error: "last_factor" }, 409);
      throw err;
    }
  });

  app.post("/recovery-codes", async (c) => {
    const p = c.get("principal");
    if (!(await mfa.hasFactor(p))) return c.json({ error: "no_factor" }, 409);
    if (await needsStepUp(p)) return c.json(mfaRequired, 403);
    return c.json({ recovery_codes: await mfa.regenerateRecovery(p, clientOf(c)) });
  });

  // ---- admin ----
  app.put("/policy", body, async (c) => {
    const p = c.get("principal");
    const parsed = await readJson(c, z.object({ policy: z.enum(POLICIES) }));
    if (!parsed) return c.json({ error: "invalid_request" }, 400);
    if (await needsStepUp(p)) return c.json(mfaRequired, 403);
    return (await mfa.setPolicy(p, parsed.policy, clientOf(c)))
      ? c.json({ policy: parsed.policy })
      : c.json(FORBIDDEN, 403);
  });

  app.get("/users/:id", async (c) => {
    const summary = await mfa.summaryOf(c.get("principal"), c.req.param("id"));
    return summary
      ? c.json({
          totp: summary.has_totp,
          passkeys: summary.passkeys,
          recovery_remaining: summary.recovery_remaining,
        })
      : c.json(FORBIDDEN, 403);
  });

  app.post("/users/:id/reset", async (c) => {
    const p = c.get("principal");
    if (await needsStepUp(p)) return c.json(mfaRequired, 403);
    const result = await mfa.resetUser(p, c.req.param("id"), clientOf(c));
    return result.ok ? c.json({ removed: result.removed }) : c.json(FORBIDDEN, 403);
  });

  return app;
}
