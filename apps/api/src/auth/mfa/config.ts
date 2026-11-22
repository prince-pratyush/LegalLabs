import type pg from "pg";
import { sealKey } from "./seal.js";
import { createMfa, type Mfa } from "./service.js";

/**
 * Second factors are switched on by setting all three variables; a half-set configuration is an
 * error, so a typo cannot leave a workspace silently without the MFA its policy promises.
 */
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
