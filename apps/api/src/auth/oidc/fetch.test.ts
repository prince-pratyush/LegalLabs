import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { BlockedFetch, isPrivateAddress, safeRequest } from "./fetch.js";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12::1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
  ])("blocks %s", (a) => expect(isPrivateAddress(a)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s",
    (a) => expect(isPrivateAddress(a)).toBe(false),
  );
});

describe("safeRequest", () => {
  it("refuses plain http", async () => {
    await expect(safeRequest("http://example.com/")).rejects.toThrow(BlockedFetch);
  });

  it("refuses literal private addresses", async () => {
    await expect(safeRequest("https://127.0.0.1/")).rejects.toThrow(BlockedFetch);
    await expect(safeRequest("https://169.254.169.254/latest/meta-data")).rejects.toThrow(
      BlockedFetch,
    );
    await expect(safeRequest("https://[::1]/")).rejects.toThrow(BlockedFetch);
  });

  it("refuses a name that resolves to a private address", async () => {
    await expect(safeRequest("https://localhost/")).rejects.toThrow(BlockedFetch);
  });

  it("refuses credentials in the URL", async () => {
    await expect(safeRequest("https://user:pw@example.com/")).rejects.toThrow(BlockedFetch);
  });

  it("does not follow redirects, and caps the size, in dev mode", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/" }).end();
      } else {
        res.end("x".repeat(2000));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await safeRequest(`${base}/redirect`, { insecureDev: true })).status).toBe(302);
      await expect(
        safeRequest(`${base}/big`, { insecureDev: true, maxBytes: 100 }),
      ).rejects.toThrow(/too large/);
    } finally {
      server.close();
    }
  });
});
