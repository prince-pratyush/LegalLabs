import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { createClientIp, trustedProxiesFromEnv } from "./client-ip.js";

/*
 * Pen-test P-10 (SEC-015, SEC-044, SEC-046): behind the ingress every request came from one
 * address, so the per-token network restriction, the SCIM allow-list, the rate limits and the
 * audit trail's IP were all about the proxy. And an address taken from X-Forwarded-For without a
 * trusted proxy is the attacker's to choose.
 */

const request = (xff?: string) =>
  ({
    req: { header: (n: string) => (n.toLowerCase() === "x-forwarded-for" ? xff : undefined) },
  }) as unknown as Context;
const from = (socket: string | null, trusted: string[]) => {
  const ip = createClientIp(trusted, () => socket);
  return (xff?: string) => ip(request(xff));
};

describe("P-10 client address behind a proxy", () => {
  it("ignores X-Forwarded-For when no proxy is trusted, so it cannot be forged", () => {
    const ip = from("203.0.113.9", []);
    expect(ip("198.51.100.1")).toBe("203.0.113.9");
    expect(ip()).toBe("203.0.113.9");
  });

  it("ignores it when the peer is not a trusted proxy", () => {
    const ip = from("203.0.113.9", ["10.0.0.0/8"]);
    expect(ip("198.51.100.1")).toBe("203.0.113.9");
  });

  it("takes the client from a trusted proxy's header", () => {
    const ip = from("10.1.2.3", ["10.0.0.0/8"]);
    expect(ip("198.51.100.7")).toBe("198.51.100.7");
  });

  it("believes only the right-hand end, so an address the client prepended is ignored", () => {
    const ip = from("10.1.2.3", ["10.0.0.0/8"]);
    // The client sent "1.2.3.4"; the proxy appended what it actually saw.
    expect(ip("1.2.3.4, 198.51.100.7")).toBe("198.51.100.7");
  });

  it("walks past a chain of trusted proxies", () => {
    const ip = from("10.1.2.3", ["10.0.0.0/8"]);
    expect(ip("198.51.100.7, 10.9.9.9, 10.8.8.8")).toBe("198.51.100.7");
  });

  it("falls back to the proxy when the header is empty, malformed or all proxies", () => {
    const ip = from("10.1.2.3", ["10.0.0.0/8"]);
    expect(ip()).toBe("10.1.2.3");
    expect(ip("not-an-address")).toBe("10.1.2.3");
    expect(ip("198.51.100.7, garbage")).toBe("10.1.2.3");
    expect(ip("10.5.5.5")).toBe("10.1.2.3");
  });

  it("handles IPv6 and IPv4-mapped peers", () => {
    expect(from("::ffff:10.1.2.3", ["10.0.0.0/8"])("198.51.100.7")).toBe("198.51.100.7");
    expect(from("fd00::1", ["fd00::/8"])("2001:db8::5")).toBe("2001:db8::5");
  });

  it("has no address when the socket has none", () => {
    expect(from(null, ["10.0.0.0/8"])("198.51.100.7")).toBeNull();
  });

  it("refuses a malformed trusted-proxy list at start-up", () => {
    expect(() => createClientIp(["not-a-network"], () => null)).toThrow();
    expect(
      trustedProxiesFromEnv({ LEGALLABS_TRUSTED_PROXIES: " 10.0.0.0/8, ,172.16.0.1 " }),
    ).toEqual(["10.0.0.0/8", "172.16.0.1"]);
    expect(trustedProxiesFromEnv({})).toEqual([]);
  });
});
