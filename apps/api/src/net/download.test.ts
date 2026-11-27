import { EventEmitter } from "node:events";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlockedFetch, safeDownload } from "./fetch.js";

/*
 * Redirects and DNS rebinding under the strict policy. Public addresses cannot be served
 * locally, so DNS and the socket are faked. The fake keeps Node's contract: the request's own
 * `lookup` is asked for every name (never for a literal address), and what it passes is what
 * would be connected to.
 */

const net = vi.hoisted(() => ({
  /** Each lookup of a name takes the next answer; the last one repeats. */
  dns: {} as Record<string, string[][]>,
  routes: {} as Record<string, { status: number; location?: string; body?: Buffer }>,
  sent: [] as { url: string; headers: Record<string, string> }[],
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
      options: {
        headers: Record<string, string>;
        lookup: (h: string, o: object, cb: (e: Error | null) => void) => void;
      },
      onResponse: (res: Readable) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        destroy(error?: Error) {
          if (error) req.emit("error", error);
          req.emit("close");
        },
        end() {
          const respond = () => {
            net.sent.push({ url: target.href, headers: options.headers });
            const route = net.routes[target.href] ?? { status: 404 };
            const res = Object.assign(Readable.from([route.body ?? Buffer.alloc(0)]), {
              statusCode: route.status,
              headers: route.location === undefined ? {} : { location: route.location },
              complete: true,
            });
            onResponse(res);
            res.on("end", () => req.emit("close"));
          };
          const host = target.hostname.replace(/^\[|\]$/g, "");
          if (isIP(host)) return queueMicrotask(respond);
          options.lookup(host, { all: true }, (error) =>
            queueMicrotask(error ? () => req.destroy(error) : respond),
          );
        },
      });
      return req;
    },
  },
}));

const PUBLIC = "93.184.216.34";
const file = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28]);

beforeEach(() => {
  net.dns = { "files.test": [[PUBLIC]], "cdn.test": [[PUBLIC]] };
  net.routes = {
    "https://files.test/a": { status: 200, body: file },
    "https://cdn.test/a": { status: 200, body: file },
  };
  net.sent = [];
});

const redirect = (to: string, status = 302) => {
  net.routes["https://files.test/start"] = { status, location: to };
};
const secret = {
  headers: { Authorization: "Bearer tok_secret", Cookie: "s=1", "x-api-key": "k" },
};

describe("safeDownload", () => {
  it("returns the bytes unchanged", async () => {
    const res = await safeDownload("https://files.test/a");
    expect(res.status).toBe(200);
    expect(res.body.equals(file)).toBe(true);
  });

  it.each([301, 302, 303, 307, 308])("follows a %s redirect and says where it ended", async (s) => {
    redirect("/a", s);
    const res = await safeDownload("https://files.test/start");
    expect(res.url).toBe("https://files.test/a");
    expect(res.body.equals(file)).toBe(true);
  });

  it.each([
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://[::1]/",
    "https://[::ffff:169.254.169.254]/",
    "https://[::ffff:0:127.0.0.1]/",
    "https://[2002:a00:1::]/",
    "https://[2001:0:a00:1::]/",
    "https://[fec0::1]/",
    "//10.0.0.1/",
    "https://internal.test/",
    "http://files.test/a",
    "ftp://files.test/a",
    "https://user:pw@files.test/a",
    "https://[bad/",
  ])("refuses a redirect to %s without sending it", async (to) => {
    net.dns["internal.test"] = [["10.0.0.5"]];
    redirect(to);
    await expect(safeDownload("https://files.test/start", {}, secret)).rejects.toThrow(
      BlockedFetch,
    );
    expect(net.sent.map((s) => s.url)).toEqual(["https://files.test/start"]);
  });

  it("refuses a name with one private address among public ones", async () => {
    net.dns["files.test"] = [[PUBLIC, "::1"]];
    await expect(safeDownload("https://files.test/a")).rejects.toThrow(BlockedFetch);
    expect(net.sent).toEqual([]);
  });

  it("checks each hop afresh, so a name re-pointed inside the network gets nothing", async () => {
    net.dns["files.test"] = [[PUBLIC], ["169.254.169.254"]];
    redirect("/a");
    await expect(safeDownload("https://files.test/start")).rejects.toThrow(BlockedFetch);
    expect(net.sent).toHaveLength(1);
  });

  it("stops after too many redirects", async () => {
    redirect("/start");
    await expect(safeDownload("https://files.test/start", { maxRedirects: 3 })).rejects.toThrow(
      /too many redirects/,
    );
    expect(net.sent).toHaveLength(4);
  });

  it("keeps the caller's headers on the same origin", async () => {
    redirect("/a");
    await safeDownload("https://files.test/start", {}, secret);
    expect(net.sent[1]?.headers.Authorization).toBe("Bearer tok_secret");
  });

  it.each(["https://cdn.test/a", "https://files.test:8443/a"])(
    "drops every caller header on the way to %s",
    async (to) => {
      redirect(to);
      await safeDownload("https://files.test/start", {}, secret);
      expect(net.sent[1]?.url).toBe(to);
      expect(JSON.stringify(net.sent[1]?.headers)).not.toMatch(/tok_secret|s=1|x-api-key/);
    },
  );

  it("does not restore the headers when a redirect comes back", async () => {
    redirect("https://cdn.test/back");
    net.routes["https://cdn.test/back"] = { status: 302, location: "https://files.test/a" };
    await safeDownload("https://files.test/start", {}, secret);
    expect(net.sent[2]?.url).toBe("https://files.test/a");
    expect(JSON.stringify(net.sent[2]?.headers)).not.toMatch(/tok_secret/);
  });

  it("only visits hosts on the allow-list, first and after redirects", async () => {
    const allow = { allowHosts: ["Files.Test"] };
    expect((await safeDownload("https://files.test/a", allow)).status).toBe(200);
    for (const url of ["https://cdn.test/a", "https://files.test.cdn.test/a"]) {
      await expect(safeDownload(url, allow)).rejects.toThrow(/host is not allowed/);
    }
    net.sent = [];
    redirect("https://cdn.test/a");
    await expect(safeDownload("https://files.test/start", allow)).rejects.toThrow(
      /host is not allowed/,
    );
    expect(net.sent).toHaveLength(1);
  });

  it("treats an empty allow-list as allowing nothing", async () => {
    await expect(safeDownload("https://files.test/a", { allowHosts: [] })).rejects.toThrow(
      /host is not allowed/,
    );
  });

  it("does not let the allow-list excuse a private address", async () => {
    net.dns["files.test"] = [["127.0.0.1"]];
    await expect(
      safeDownload("https://files.test/a", { allowHosts: ["files.test"] }),
    ).rejects.toThrow(/address is not allowed/);
  });
});
