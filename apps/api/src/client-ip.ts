import { isIP } from "node:net";
import type { Context } from "hono";
import { ipAllowed, parseCidrs } from "./public-api/service.js";

const bare = (ip: string) => (ip.startsWith("::ffff:") ? ip.slice(7) : ip);

/**
 * The address of the person making the request. Behind the ingress that terminates TLS (the
 * normal deployment) the socket address is the ingress, so rate limits, API-token network
 * restrictions, the SCIM allow-list and the audit trail would all see one address for everybody.
 *
 * Forwarded headers are forgeable, so they are believed only from a peer the deployer listed as a
 * trusted proxy, and then only from the right: each trusted proxy appends the address it saw, so
 * the first address from the right that is not a trusted proxy is the client. Anything an attacker
 * put to the left of that is ignored. With no trusted proxies the socket address is used as is.
 */
export function createClientIp(
  trustedProxies: string[],
  socketIp: (c: Context) => string | null,
): (c: Context) => string | null {
  const trusted = parseCidrs(trustedProxies);
  const isTrusted = (ip: string) => trusted.length > 0 && ipAllowed(ip, trusted);
  return (c) => {
    const socket = socketIp(c);
    if (socket === null || !isTrusted(socket)) return socket;
    const hops = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((h) => bare(h.trim()))
      .filter((h) => h !== "");
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i] as string;
      // A malformed entry means the chain cannot be trusted: fall back to the proxy itself.
      if (isIP(hop) === 0) return socket;
      if (!isTrusted(hop)) return hop;
    }
    return socket;
  };
}

/** `LEGALLABS_TRUSTED_PROXIES`: comma-separated addresses or CIDR blocks of the ingress. */
export function trustedProxiesFromEnv(env: NodeJS.ProcessEnv): string[] {
  return (env.LEGALLABS_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
