import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export interface FetchPolicy {
  /** Test and local development only: plain http and private addresses. */
  insecureDev?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface FetchResult {
  status: number;
  body: string;
}

export class BlockedFetch extends Error {}

const V4_BLOCKED: [number, number][] = [
  [0x00000000, 8], // this network
  [0x0a000000, 8], // private
  [0x64400000, 10], // carrier-grade NAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link local, including cloud metadata
  [0xac100000, 12], // private
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // documentation
  [0xc0a80000, 16], // private
  [0xc6120000, 15], // benchmarking
  [0xc6336400, 24], // documentation
  [0xcb007100, 24], // documentation
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved and broadcast
];

function v4ToInt(address: string): number {
  return address.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

/** True for any address a server-side fetch must never reach. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const n = v4ToInt(address);
    return V4_BLOCKED.some(([base, bits]) => {
      const size = 2 ** (32 - bits);
      return n >= base && n < base + size;
    });
  }
  const a = address.toLowerCase().split("%")[0] ?? "";
  // IPv4 carried inside IPv6 is judged by the IPv4 rules.
  const mapped = /^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  const hex = /^(?:::ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex?.[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return (
    a === "::" ||
    a === "::1" ||
    a.startsWith("fc") || // unique local
    a.startsWith("fd") ||
    /^fe[89ab]/.test(a) || // link local
    a.startsWith("ff") || // multicast
    a.startsWith("64:ff9b:") || // NAT64 can reach private IPv4
    a.startsWith("2001:db8") // documentation
  );
}

/**
 * GET with the checks a fetch of an operator-supplied URL needs: https only, no private
 * address (checked on the address actually connected to, so DNS rebinding can't slip past),
 * no redirects, a short timeout and a size cap.
 */
export function safeRequest(
  url: string,
  policy: FetchPolicy = {},
  init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string } = {},
): Promise<FetchResult> {
  const { insecureDev = false, timeoutMs = 5000, maxBytes = 1_000_000 } = policy;
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new BlockedFetch("not a URL"));
      return;
    }
    if (target.protocol !== "https:" && !(insecureDev && target.protocol === "http:")) {
      reject(new BlockedFetch("only https is allowed"));
      return;
    }
    if (target.username || target.password) {
      reject(new BlockedFetch("credentials in a URL are not allowed"));
      return;
    }
    const host = target.hostname.replace(/^\[|\]$/g, "");
    // A literal address skips DNS, so it is judged here.
    if (!insecureDev && isIP(host) !== 0 && isPrivateAddress(host)) {
      reject(new BlockedFetch("address is not allowed"));
      return;
    }
    const lookup: typeof dnsLookup = ((hostname: string, options: unknown, cb: unknown) => {
      const callback = (typeof options === "function" ? options : cb) as (
        err: Error | null,
        address?: string | { address: string; family: number }[],
        family?: number,
      ) => void;
      const wantAll = typeof options === "object" && options !== null && "all" in options;
      dnsLookup(hostname, { all: true }, (err, addresses) => {
        if (err) return callback(err);
        if (!insecureDev && addresses.some((a) => isPrivateAddress(a.address))) {
          return callback(new BlockedFetch("address is not allowed"));
        }
        const first = addresses[0];
        if (!first) return callback(new Error("no address"));
        if (wantAll && (options as { all?: boolean }).all) return callback(null, addresses);
        callback(null, first.address, first.family);
      });
    }) as typeof dnsLookup;

    const transport = target.protocol === "https:" ? https : http;
    const req = transport.request(
      target,
      {
        method: init.method ?? "GET",
        headers: { accept: "application/json", ...init.headers },
        lookup,
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooBig = false;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            tooBig = true;
            req.destroy(new BlockedFetch("response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (tooBig) return reject(new BlockedFetch("response too large"));
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end(init.body);
  });
}
