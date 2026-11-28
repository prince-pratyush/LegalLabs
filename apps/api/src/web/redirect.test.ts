import { EventEmitter } from "node:events";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPageFetcher } from "./fetcher.js";

/*
 * Redirects and DNS under the strict policy. Public addresses cannot be served locally, so
 * DNS and the socket are faked, keeping Node's contract: the request's own `lookup` is asked
 * for every name, and what it passes is what would be connected to.
 */

const net = vi.hoisted(() => ({
  dns: {} as Record<string, string[][]>,
  routes: {} as Record<string, { status: number; location?: string; body?: string }>,
  sent: [] as string[],
}));

vi.mock("node:dns", () => ({
  lookup: (
    host: string,
    _options: unknown,
    callback: (e: Error | null, a?: { address: string; family: number }[]) => void,
  ) => {
    const answers = net.dns[host];
    const next = answers && answers.length > 1 ? answers.shift() : answers?.[0];
    if (!next) return callback(new Error("ENOTFOUND"));
    callback(
      null,
      next.map((address) => ({ address, family: isIP(address) })),
    );
  },
}));

vi.mock("node:https", () => ({
  default: {
    request: (
      target: URL,
      options: { lookup: (h: string, o: object, cb: (e: Error | null) => void) => void },
      onResponse: (res: Readable) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        destroy(error?: Error) {
          if (error) req.emit("error", error);
          req.emit("close");
        },
        end() {
          options.lookup(target.hostname, {}, (error) => {
            if (error) return req.destroy(error);
            net.sent.push(target.href);
            const route = net.routes[target.href] ?? { status: 404 };
            const res = Object.assign(Readable.from([Buffer.from(route.body ?? "")]), {
              statusCode: route.status,
              headers: {
                "content-type": "text/html",
                ...(route.location ? { location: route.location } : {}),
              },
            });
            onResponse(res);
            res.on("end", () => req.emit("close"));
          });
        },
      });
      return req;
    },
  },
}));

const PUBLIC = "93.184.216.34";

beforeEach(() => {
  net.dns = { "a.test": [[PUBLIC]], "b.test": [[PUBLIC]] };
  net.routes = {};
  net.sent = [];
});

const fetch = (url: string) => createPageFetcher({ onRefused: () => {} }).fetch(url);

describe("the page fetcher across hosts", () => {
  it("follows a redirect to another public host, asking its robots.txt", async () => {
    net.routes["https://a.test/x"] = { status: 302, location: "https://b.test/y" };
    net.routes["https://b.test/y"] = { status: 200, body: "<p>there</p>" };
    const result = await fetch("https://a.test/x");
    expect(result.ok && result.page.url).toBe("https://b.test/y");
    expect(net.sent).toContain("https://b.test/robots.txt");
  });

  it.each([
    ["a private literal", "https://10.0.0.5/"],
    ["a name that resolves privately", "https://inside.test/"],
  ])("refuses a redirect to %s without connecting", async (_name, location) => {
    net.dns["inside.test"] = [["192.168.1.1"]];
    net.routes["https://a.test/x"] = { status: 302, location };
    expect(await fetch("https://a.test/x")).toEqual({ ok: false, reason: "SSRF_BLOCKED" });
    expect(net.sent.every((url) => url.startsWith("https://a.test/"))).toBe(true);
  });

  it("refuses a redirect to plain http or another port", async () => {
    for (const location of ["http://b.test/", "https://b.test:22/"]) {
      net.routes["https://a.test/x"] = { status: 302, location };
      expect(await fetch("https://a.test/x")).toEqual({ ok: false, reason: "NOT_ALLOWED_URL" });
    }
  });

  it("refuses a name whose address turns private after the robots check", async () => {
    net.dns["a.test"] = [[PUBLIC], ["127.0.0.1"]];
    net.routes["https://a.test/x"] = { status: 200, body: "<p>x</p>" };
    expect(await fetch("https://a.test/x")).toEqual({ ok: false, reason: "SSRF_BLOCKED" });
    expect(net.sent).toEqual(["https://a.test/robots.txt"]);
  });

  it("refuses a name with any private address among public ones", async () => {
    net.dns["a.test"] = [[PUBLIC, "10.0.0.1"]];
    expect(await fetch("https://a.test/x")).toEqual({ ok: false, reason: "SSRF_BLOCKED" });
    expect(net.sent).toEqual([]);
  });
});
