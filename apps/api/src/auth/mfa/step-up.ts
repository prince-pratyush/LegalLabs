import type { Principal } from "../auth.js";

export const POLICIES = ["off", "admins", "all", "all_incl_guests"] as const;
export type MfaPolicy = (typeof POLICIES)[number];

/** How recently a factor must have been shown for a sensitive action. */
export const FRESH_MFA_MS = 15 * 60 * 1000;

export class MfaRequiredError extends Error {
  readonly code = "MFA_REQUIRED";
  constructor() {
    super("Confirm with your second factor to continue.");
  }
}

export function hasFreshMfa(
  principal: Pick<Principal, "mfaAt">,
  windowMs = FRESH_MFA_MS,
  now = Date.now(),
): boolean {
  const at = principal.mfaAt?.getTime();
  // A time in the future is never fresh: it can only come from a clock fault.
  return at !== undefined && at <= now && now - at <= windowMs;
}

/** Step-up for a sensitive action: throws unless a factor was shown within the window. */
export function requireFreshMfa(
  principal: Pick<Principal, "mfaAt">,
  windowMs = FRESH_MFA_MS,
  now = Date.now(),
): void {
  if (!hasFreshMfa(principal, windowMs, now)) throw new MfaRequiredError();
}
