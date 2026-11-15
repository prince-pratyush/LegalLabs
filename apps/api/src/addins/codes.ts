import { createHash, randomBytes } from "node:crypto";

// Long enough for the dialog to hand the code over, short enough that a leaked one is stale.
export const CODE_MS = 60_000;
const MAX_CODES = 1_000;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export interface CodeStore {
  /** A one-time code standing in for the session token, so the token never crosses windows. */
  issue(token: string): string;
  /** The token, once: a second redeem of the same code gets nothing. */
  redeem(code: string): string | null;
}

/**
 * In memory: codes live a minute, and the pilot runs one API process.
 * Several processes would need these in the database.
 */
export function createCodeStore(now: () => number = Date.now): CodeStore {
  const codes = new Map<string, { token: string; expires: number }>();

  const sweep = () => {
    const at = now();
    for (const [key, entry] of codes) if (entry.expires <= at) codes.delete(key);
  };

  return {
    issue(token) {
      sweep();
      // Oldest first, so a flood of sign-ins can't grow memory without bound.
      while (codes.size >= MAX_CODES) {
        const oldest = codes.keys().next().value;
        if (oldest === undefined) break;
        codes.delete(oldest);
      }
      const code = randomBytes(32).toString("base64url");
      codes.set(sha256(code), { token, expires: now() + CODE_MS });
      return code;
    },

    redeem(code) {
      const key = sha256(code);
      const entry = codes.get(key);
      codes.delete(key);
      if (!entry || entry.expires <= now()) return null;
      return entry.token;
    },
  };
}
