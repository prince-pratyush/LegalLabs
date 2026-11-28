import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

export interface FetchPolicy {
  /** Test and local development only: plain http and private addresses. */
  insecureDev?: boolean;
  /** How long the socket may be silent. */
  timeoutMs?: number;
  /** How long the whole exchange may take, however steadily bytes arrive. */
  deadlineMs?: number;
  maxBytes?: number;
  /**
   * One operator-configured origin that may be plain http or on a private network, such as a
   * self-hosted search service. Never set from anything a person or a model can influence.
   */
  trustedOrigin?: string;
}

export interface FetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type BlockedCode = "url" | "address" | "host" | "size" | "redirects";

export class BlockedFetch extends Error {
  constructor(
    message: string,
    readonly code: BlockedCode,
  ) {
    super(message);
  }
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link local, including cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
];

const subnets = (type: "ipv4" | "ipv6", ranges: [string, number][]) => {
  const list = new BlockList();
  for (const [network, prefix] of ranges) list.addSubnet(network, prefix, type);
  return list;
};

// Also matches the IPv4-mapped IPv6 form of each range.
const v4Blocked = subnets("ipv4", V4_BLOCKED);
const v4Mapped = subnets("ipv6", [["::ffff:0:0", 96]]);
// Only global unicast is public. Everything outside it is refused: loopback, link, site and
// unique local, multicast, NAT64, and the other ways of carrying an IPv4 address.
const v6Global = subnets("ipv6", [["2000::", 3]]);
const v6Blocked = subnets("ipv6", [
  ["2001::", 32], // Teredo: tunnels to an IPv4 address
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: tunnels to an IPv4 address
]);

/** True for any address a server-side fetch must never reach, and for anything unreadable. */
export function isPrivateAddress(address: string): boolean {
  const a = address.split("%")[0] ?? "";
  const family = isIP(a);
  if (family === 4) return v4Blocked.check(a, "ipv4");
  if (family !== 6) return true;
  // IPv4 carried inside IPv6 is judged by the IPv4 rules.
  if (v4Mapped.check(a, "ipv6")) return v4Blocked.check(a, "ipv6");
  return !v6Global.check(a, "ipv6") || v6Blocked.check(a, "ipv6");
}

/**
 * A request with the checks a fetch of an untrusted URL needs: https only, no private
 * address (checked on the address actually connected to, so DNS rebinding can't slip past),
 * no redirects, timeouts and a size cap.
 */
export async function safeRequest(
  url: string,
  policy: FetchPolicy = {},
  init: Exchange = {},
): Promise<FetchResult> {
  const res = await exchange(url, policy, init);
  return { ...res, body: res.body.toString("utf8") };
}

export interface DownloadPolicy extends FetchPolicy {
  /** When given, the only host names that may be visited, matched exactly. Empty allows none. */
  allowHosts?: readonly string[];
  maxRedirects?: number;
  /**
   * A further check made before every hop, the first included; throwing ends the download.
   * It is told how much of the deadline is left, and its own time counts against it.
   */
  onHop?: (url: URL, msLeft: number) => void | Promise<void>;
}

export interface DownloadResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** Where the bytes came from, after any redirects. */
  url: string;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * A GET of a file, with the checks of `safeRequest` made again on every redirect hop. The
 * caller's headers go only to the first origin: once a redirect leaves it, all of them are
 * dropped for good. The deadline covers the whole chain.
 */
export async function safeDownload(
  url: string,
  policy: DownloadPolicy = {},
  init: {
    headers?: Record<string, string>;
    /** Sent to every host visited, so nothing secret belongs here. */
    publicHeaders?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<DownloadResult> {
  const { allowHosts, maxRedirects = 5, deadlineMs = 60_000, maxBytes = 10_000_000 } = policy;
  const allowed = allowHosts?.map((host) => host.toLowerCase());
  const until = Date.now() + deadlineMs;
  let target = parse(url);
  let headers = init.headers;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (allowed && !allowed.includes(target.hostname)) {
      throw new BlockedFetch("host is not allowed", "host");
    }
    await policy.onHop?.(new URL(target), until - Date.now());
    const left = until - Date.now();
    if (left <= 0) throw new Error("request took too long");
    const res = await exchange(
      target.href,
      { ...policy, deadlineMs: left, maxBytes },
      {
        ...(init.signal ? { signal: init.signal } : {}),
        headers: { accept: "*/*", ...headers, ...init.publicHeaders },
      },
    );
    const { location } = res.headers;
    if (!REDIRECTS.has(res.status) || location === undefined) {
      return { ...res, url: target.href };
    }
    const next = parse(location, target);
    if (next.origin !== target.origin) headers = undefined;
    target = next;
  }
  throw new BlockedFetch("too many redirects", "redirects");
}

function parse(url: string, base?: URL): URL {
  try {
    return new URL(url, base);
  } catch {
    throw new BlockedFetch("not a URL", "url");
  }
}

interface Exchange {
  method?: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /**
   * Shown each chunk as it arrives; true ends the exchange with what has been read. For a
   * stream the server may hold open after it has said what was asked.
   */
  enough?: (chunk: Buffer, headers: http.IncomingHttpHeaders) => boolean;
}

/** One request and its response, as bytes. */
function exchange(
  url: string,
  policy: FetchPolicy,
  init: Exchange,
): Promise<Omit<DownloadResult, "url">> {
  const { insecureDev = false, timeoutMs = 5000, deadlineMs, maxBytes = 1_000_000 } = policy;
  return new Promise((resolve, reject) => {
    // A throw here rejects the promise.
    const target = parse(url);
    const open = insecureDev || target.origin === policy.trustedOrigin;
    if (target.protocol !== "https:" && !(open && target.protocol === "http:")) {
      reject(new BlockedFetch("only https is allowed", "url"));
      return;
    }
    if (target.username || target.password) {
      reject(new BlockedFetch("credentials in a URL are not allowed", "url"));
      return;
    }
    const host = target.hostname.replace(/^\[|\]$/g, "");
    // A literal address skips DNS, so it is judged here.
    if (!open && isIP(host) !== 0 && isPrivateAddress(host)) {
      reject(new BlockedFetch("address is not allowed", "address"));
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
        if (!open && addresses.some((a) => isPrivateAddress(a.address))) {
          return callback(new BlockedFetch("address is not allowed", "address"));
        }
        const first = addresses[0];
        if (!first) return callback(new Error("no address"));
        if (wantAll && (options as { all?: boolean }).all) return callback(null, addresses);
        callback(null, first.address, first.family);
      });
    }) as typeof dnsLookup;

    const transport = target.protocol === "https:" ? https : http;
    let answered = false;
    const req = transport.request(
      target,
      {
        method: init.method ?? "GET",
        headers: { accept: "application/json", ...init.headers },
        lookup,
        timeout: timeoutMs,
        agent: false,
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        answered = true;
        const chunks: Buffer[] = [];
        let size = 0;
        let tooBig = false;
        const done = () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            tooBig = true;
            req.destroy(new BlockedFetch("response too large", "size"));
            return;
          }
          chunks.push(chunk);
          if (init.enough?.(chunk, res.headers)) {
            done();
            req.destroy();
          }
        });
        res.on("end", () => {
          if (tooBig) return reject(new BlockedFetch("response too large", "size"));
          done();
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    // A "101 Switching Protocols" closes the request with neither a response nor an error.
    req.on("close", () => {
      if (!answered) reject(new Error("no response"));
    });
    if (deadlineMs) {
      const timer = setTimeout(() => {
        reject(new Error("request took too long"));
        req.destroy();
      }, deadlineMs);
      req.on("close", () => clearTimeout(timer));
    }
    req.end(init.body);
  });
}
