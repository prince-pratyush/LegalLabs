import type { MiddlewareHandler } from "hono";
import type { Principal } from "../auth.js";
import { FRESH_MFA_MS, hasFreshMfa } from "./step-up.js";

/**
 * The actions that need a second factor shown within the last 15 minutes (SEC-007, 06-security
 * 3.2): changing a retention policy, placing or lifting a legal hold, adding a guest
 * organisation to a Space, and changing single sign-on. Creating an API token has its own check beside the token routes.
 * One list here, rather than a check in every route, so a new route cannot forget it.
 */
const SENSITIVE: readonly (readonly [method: string, path: RegExp])[] = [
  ["PUT", /^\/api\/v1\/admin\/retention\/policy$/],
  ["DELETE", /^\/api\/v1\/admin\/retention\/policy$/],
  ["PUT", /^\/api\/v1\/admin\/retention\/holds$/],
  ["POST", /^\/api\/v1\/spaces\/[^/]+\/parties$/],
  ["PUT", /^\/api\/v1\/admin\/identity\/sso$/],
];

export const isStepUpAction = (method: string, path: string) =>
  SENSITIVE.some(([m, re]) => m === method.toUpperCase() && re.test(path));

type Env = { Variables: { principal: Principal } };

/**
 * Refuses a sensitive action with 403 MFA_REQUIRED unless the session has shown a factor
 * recently. Someone with no factor cannot be asked for one: the workspace policy has already
 * decided whether they may sign in without, as it does for token creation.
 */
export function stepUpGate(
  mfa: { hasFactor(p: Principal): Promise<boolean> },
  now: () => number = Date.now,
): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!isStepUpAction(c.req.method, c.req.path)) return next();
    const p = c.get("principal");
    if (!hasFreshMfa(p, FRESH_MFA_MS, now()) && (await mfa.hasFactor(p))) {
      return c.json(
        { code: "MFA_REQUIRED", message: "Confirm with your second factor to continue." },
        403,
      );
    }
    return next();
  };
}
