import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createSearxng, webSearchFromEnv } from "./searxng.js";

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

describe("the SearXNG provider", () => {
  it("posts the query in the body and keeps only https results", async () => {
    const seen: { method?: string | undefined; url?: string | undefined; body: string }[] = [];
    await serve(
      (req, res) => {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          seen.push({ method: req.method, url: req.url, body });
          res.end(
            JSON.stringify({
              results: [
                {
                  url: "https://example.org/a",
                  title: "A",
                  content: "snippet",
                  publishedDate: "2026-01-01T00:00:00",
                },
                { url: "https://example.org/a#again", title: "A again" },
                { url: "http://example.org/plain", title: "plain" },
                { url: "javascript:alert(1)", title: "script" },
                { url: 5 },
                { url: "https://example.org/b", title: "x".repeat(900) },
                { url: "https://example.org/c" },
              ],
            }),
          );
        });
      },
      async (base) => {
        const search = createSearxng({ url: `${base}/searx/`, allowInternal: true });
        const results = await search.search("rent review & fees", { limit: 2, recencyDays: 20 });
        expect(results).toEqual([
          {
            url: "https://example.org/a",
            title: "A",
            snippet: "snippet",
            publishedAt: "2026-01-01T00:00:00",
          },
          { url: "https://example.org/b", title: "x".repeat(300), snippet: "" },
        ]);
        expect(search.host).toBe(new URL(base).host);
      },
    );
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("/searx/search");
    const sent = new URLSearchParams(seen[0]?.body);
    expect(Object.fromEntries(sent)).toEqual({
      q: "rent review & fees",
      format: "json",
      safesearch: "1",
      time_range: "month",
    });
  });

  it("does not follow a redirect, and fails on anything that is not its JSON", async () => {
    await serve(
      (req, res) => {
        if (req.url === "/r/search") res.writeHead(302, { location: "/other" }).end();
        else res.end("<html>");
      },
      async (base) => {
        for (const url of [`${base}/r`, base]) {
          const search = createSearxng({ url, allowInternal: true });
          await expect(search.search("q", { limit: 3 })).rejects.toThrow();
        }
      },
    );
  });

  it("reaches an internal address only when told to", async () => {
    await serve(
      (_req, res) => res.end('{"results":[]}'),
      async (base) => {
        const secure = base.replace("http:", "https:");
        for (const url of [secure, "https://localhost/"]) {
          await expect(createSearxng({ url }).search("q", { limit: 1 })).rejects.toThrow(
            "address is not allowed",
          );
        }
      },
    );
  });
});

describe("webSearchFromEnv", () => {
  it("is off when unset", () => {
    expect(webSearchFromEnv({})).toBeNull();
  });

  it("builds a provider from the endpoint", () => {
    expect(webSearchFromEnv({ LEGALLABS_SEARXNG_URL: "https://search.example/" })?.host).toBe(
      "search.example",
    );
    expect(
      webSearchFromEnv({
        LEGALLABS_SEARXNG_URL: "http://searxng:8080",
        LEGALLABS_SEARXNG_INTERNAL: "true",
      })?.host,
    ).toBe("searxng:8080");
  });

  it.each([
    [{ LEGALLABS_SEARXNG_INTERNAL: "true" }],
    [{ LEGALLABS_SEARXNG_URL: "http://search.example" }],
    [{ LEGALLABS_SEARXNG_URL: "search.example" }],
    [{ LEGALLABS_SEARXNG_URL: "https://u:p@search.example" }],
    [{ LEGALLABS_SEARXNG_URL: "https://search.example/?token=1" }],
    [{ LEGALLABS_SEARXNG_URL: "https://search.example", LEGALLABS_SEARXNG_INTERNAL: "yes" }],
  ])("throws on %o", (env) => {
    expect(() => webSearchFromEnv(env)).toThrow();
  });
});
