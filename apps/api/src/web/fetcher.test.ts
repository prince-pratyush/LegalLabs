import { createServer, type IncomingHttpHeaders, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createPageFetcher } from "./fetcher.js";

const html = { "content-type": "text/html; charset=utf-8" };

const serve = async (handler: RequestListener, run: (base: string) => Promise<void>) => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
};

/** A site with no robots.txt unless the route says otherwise. */
const site =
  (routes: Record<string, [number, Record<string, string>, string | Buffer]>): RequestListener =>
  (req, res) => {
    const [status, headers, body] = routes[req.url ?? ""] ?? [404, {}, ""];
    res.writeHead(status, headers).end(body);
  };

const fetcher = (options = {}) => createPageFetcher({ insecureDev: true, ...options });

describe("the page fetcher", () => {
  it("returns readable text, the title and when it was fetched", async () => {
    const at = new Date("2026-01-02T03:04:05Z");
    await serve(
      site({ "/a": [200, html, "<title>T</title><p>Hello</p><script>x()</script>"] }),
      async (base) => {
        const result = await fetcher({ now: () => at }).fetch(`${base}/a#part`);
        expect(result).toEqual({
          ok: true,
          page: { url: `${base}/a`, title: "T", text: "Hello", fetchedAt: at },
        });
      },
    );
  });

  it("sends no cookies, credentials or referrer", async () => {
    const seen: IncomingHttpHeaders[] = [];
    await serve(
      (req, res) => {
        seen.push(req.headers);
        if (req.url === "/a") res.writeHead(302, { location: "/b", "set-cookie": "s=1" }).end();
        else if (req.url === "/b") res.writeHead(200, html).end("<p>x</p>");
        else res.writeHead(404).end();
      },
      async (base) => {
        expect((await fetcher().fetch(`${base}/a`)).ok).toBe(true);
      },
    );
    expect(seen.length).toBeGreaterThan(1);
    for (const headers of seen) {
      expect(headers["user-agent"]).toBe("LegalLabs/1.0");
      expect(headers["accept-encoding"]).toBe("identity");
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      expect(headers.referer).toBeUndefined();
    }
  });

  it("decodes the declared character set", async () => {
    await serve(
      site({
        "/a": [
          200,
          { "content-type": "text/plain; charset=iso-8859-1" },
          Buffer.from([0x63, 0x61, 0x66, 0xe9]),
        ],
      }),
      async (base) => {
        const result = await fetcher().fetch(`${base}/a`);
        expect(result.ok && result.page.text).toBe("café");
      },
    );
  });

  it("asks robots.txt first, on every redirect hop", async () => {
    const paths: string[] = [];
    await serve(
      (req, res) => {
        paths.push(req.url ?? "");
        if (req.url === "/robots.txt") res.end("User-agent: *\nDisallow: /no");
        else if (req.url === "/go") res.writeHead(302, { location: "/no/page" }).end();
        else res.writeHead(200, html).end("<p>secret</p>");
      },
      async (base) => {
        expect(await fetcher().fetch(`${base}/no`)).toEqual({
          ok: false,
          reason: "ROBOTS_DISALLOWED",
        });
        expect(await fetcher().fetch(`${base}/go`)).toEqual({
          ok: false,
          reason: "ROBOTS_DISALLOWED",
        });
      },
    );
    expect(paths).not.toContain("/no/page");
    expect(paths).not.toContain("/no");
  });

  it("stays out when robots.txt fails on the server's side", async () => {
    await serve(
      site({ "/robots.txt": [503, {}, ""], "/a": [200, html, "<p>x</p>"] }),
      async (base) => {
        expect(await fetcher().fetch(`${base}/a`)).toEqual({
          ok: false,
          reason: "ROBOTS_DISALLOWED",
        });
      },
    );
  });

  it("refuses other types, compressed bodies, errors, empty pages and big ones", async () => {
    await serve(
      site({
        "/pdf": [200, { "content-type": "application/pdf" }, "%PDF"],
        "/none": [200, {}, "x"],
        "/gz": [200, { ...html, "content-encoding": "gzip" }, "x"],
        "/missing": [410, html, "gone"],
        "/empty": [200, html, "<script>x</script>"],
        "/big": [200, html, "x".repeat(5000)],
      }),
      async (base) => {
        const reason = async (path: string) => {
          const result = await fetcher({ maxBytes: 4000 }).fetch(`${base}${path}`);
          return result.ok ? "ok" : result.reason;
        };
        expect(await reason("/pdf")).toBe("UNSUPPORTED_TYPE");
        expect(await reason("/none")).toBe("UNSUPPORTED_TYPE");
        expect(await reason("/gz")).toBe("UNSUPPORTED_TYPE");
        expect(await reason("/missing")).toBe("HTTP_ERROR");
        expect(await reason("/empty")).toBe("EMPTY");
        expect(await reason("/big")).toBe("TOO_LARGE");
      },
    );
  });

  it("has one deadline for robots, redirects and a body that trickles", async () => {
    await serve(
      (req, res) => {
        if (req.url === "/robots.txt") return void setTimeout(() => res.writeHead(404).end(), 150);
        if (req.url === "/a") return void res.writeHead(302, { location: "/b" }).end();
        res.writeHead(200, html);
        const timer = setInterval(() => res.write("x"), 20);
        res.on("close", () => clearInterval(timer));
      },
      async (base) => {
        const started = Date.now();
        const result = await fetcher({ deadlineMs: 500 }).fetch(`${base}/a`);
        expect(result).toEqual({ ok: false, reason: "TIMEOUT" });
        expect(Date.now() - started).toBeLessThan(2_000);
      },
    );
  });

  it("stops when the caller gives up", async () => {
    await serve(
      () => {},
      async (base) => {
        const result = await fetcher().fetch(`${base}/a`, { signal: AbortSignal.timeout(100) });
        expect(result.ok).toBe(false);
      },
    );
  });

  it("gives up after too many redirects", async () => {
    await serve(
      (req, res) => {
        if (req.url === "/robots.txt") res.writeHead(404).end();
        else res.writeHead(302, { location: `/${Math.random()}` }).end();
      },
      async (base) => {
        expect(await fetcher().fetch(`${base}/a`)).toEqual({
          ok: false,
          reason: "TOO_MANY_REDIRECTS",
        });
      },
    );
  });

  it("refuses private addresses, other schemes, ports and credentials, and says so", async () => {
    const refused: string[] = [];
    const strict = createPageFetcher({
      onRefused: (reason, host) => refused.push(`${reason} ${host}`),
    });
    for (const url of [
      "https://127.0.0.1/",
      "https://2130706433/",
      "https://[::1]/",
      "https://[::ffff:10.0.0.1]/",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/",
    ]) {
      expect(await strict.fetch(url)).toEqual({ ok: false, reason: "SSRF_BLOCKED" });
    }
    for (const url of [
      "http://example.com/",
      "file:///etc/passwd",
      "https://user:pw@example.com/",
      "https://example.com:8443/",
      "not a url",
      `https://example.com/${"a".repeat(3000)}`,
    ]) {
      expect(await strict.fetch(url)).toEqual({ ok: false, reason: "NOT_ALLOWED_URL" });
    }
    expect(refused).toContain("SSRF_BLOCKED 127.0.0.1");
    expect(refused.join()).not.toContain("meta-data");
  });
});
