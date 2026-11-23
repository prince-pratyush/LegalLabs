import type pg from "pg";
import { sealKey } from "./seal.js";
import { createMfa, type Mfa } from "./service.js";

/**
 * Second factors are switched on by setting all three variables; a half-set configuration is an
 * error, so a typo cannot leave a workspace silently without the MFA its policy promises.
 */
const NO_MFA =
  "second factors are not configured (set LEGALLABS_MFA_RP_ID, LEGALLABS_MFA_ORIGINS and LEGALLABS_MFA_KEY): " +
  "administrators sign in with a password alone and the step-up checks for retention, legal holds, " +
  "guest organisations and API tokens are off";

/**
 * What start-up should do about MFA. The design's default is "required for admins", but nothing
 * enforces a factor until the three variables above are set, so a production deployment that
 * forgot them would silently run without. It must say so on purpose: set them, or set
 * LEGALLABS_ALLOW_NO_MFA=1 to accept running without.
 */
export function mfaStartupCheck(
  env: NodeJS.ProcessEnv,
  configured: boolean,
): { action: "ok" | "warn" | "refuse"; message: string } {
  if (configured) return { action: "ok", message: "" };
  if (env.NODE_ENV === "production" && env.LEGALLABS_ALLOW_NO_MFA !== "1") {
    return {
      action: "refuse",
      message: `${NO_MFA}. Set them, or set LEGALLABS_ALLOW_NO_MFA=1 to run without.`,
    };
  }
  return { action: "warn", message: `warning: ${NO_MFA}.` };
}

export function mfaFromEnv(env: NodeJS.ProcessEnv, pool: pg.Pool): { mfa?: Mfa } {
  const rpID = env.LEGALLABS_MFA_RP_ID;
  const origins = env.LEGALLABS_MFA_ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const key = env.LEGALLABS_MFA_KEY;
  if (!rpID && !origins?.length && !key) return {};
  if (!rpID || !origins?.length || !key) {
    throw new Error(
      "set LEGALLABS_MFA_RP_ID, LEGALLABS_MFA_ORIGINS and LEGALLABS_MFA_KEY together",
    );
  }
  return {
    mfa: createMfa(pool, {
      rpID,
      rpName: env.LEGALLABS_MFA_RP_NAME || "LegalLabs",
      origins,
      encryptionKey: sealKey(key),
    }),
  };
}
