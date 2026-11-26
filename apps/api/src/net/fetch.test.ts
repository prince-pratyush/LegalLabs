import { createServer, type RequestListener } from "node:http";
import { type AddressInfo, createServer as createTcpServer } from "node:net";
import { describe, expect, it } from "vitest";
import { BlockedFetch, isPrivateAddress, safeDownload, safeRequest } from "./fetch.js";

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
    "0:0:0:0:0:0:0:1",
    "0:0:0:0:0:ffff:0a00:0001",
    "::127.0.0.1",
    "::7f00:1",
    "::ffff:0:127.0.0.1", // IPv4-translated
    "::ffff:0:8.8.8.8",
    "2002:7f00:1::", // 6to4
    "2002:808:808::1",
    "2001::1", // Teredo
    "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
    "2001:db8::1",
    "fec0::1", // site local
    "feff::1",
    "fe80::1%en0",
    "ff02::1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::a00:1",
    "100::1",
    "not-an-address",
    "",
  ])("blocks %s", (a) => expect(isPrivateAddress(a)).toBe(true));

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "2001:4860:4860::8888",
  ])("allows %s", (a) => expect(isPrivateAddress(a)).toBe(false));
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
const dev = { insecureDev: true };

describe("safeDownload over a real socket", () => {
  const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 256));

  it("round-trips binary content through a redirect", async () => {
    await serve(
      (req, res) => {
        if (req.url === "/start") res.writeHead(302, { location: "/file" }).end();
        else res.end(bytes);
      },
      async (base) => {
        const res = await safeDownload(`${base}/start`, dev);
        expect(res.body.equals(bytes)).toBe(true);
      },
    );
  });

  it("caps the size, declared or not", async () => {
    await serve(
      (_req, res) => {
        res.write(bytes);
        res.end();
      },
      async (base) => {
        await expect(safeDownload(base, { ...dev, maxBytes: 1000 })).rejects.toThrow(/too large/);
      },
    );
  });

  it("refuses a file cut short", async () => {
    await serve(
      (_req, res) => {
        res.writeHead(200, { "content-length": "1000" });
        res.write("part", () => res.destroy());
      },
      async (base) => {
        await expect(safeDownload(base, dev)).rejects.toThrow();
      },
    );
  });

  it("holds one deadline across every hop, however steadily bytes arrive", async () => {
    let hops = 0;
    await serve(
      (_req, res) => {
        hops += 1;
        setTimeout(() => res.writeHead(302, { location: "/again" }).end(), 150);
      },
      async (base) => {
        await expect(
          safeDownload(base, { ...dev, deadlineMs: 400, maxRedirects: 50 }),
        ).rejects.toThrow(/too long/);
        expect(hops).toBeLessThan(5);
      },
    );
    await serve(
      (_req, res) => {
        const drip = setInterval(() => res.write("x"), 20);
        res.on("close", () => clearInterval(drip));
      },
      async (base) => {
        await expect(safeDownload(base, { ...dev, deadlineMs: 200 })).rejects.toThrow(/too long/);
      },
    );
  });
});

describe("a server that switches protocols", () => {
  it.each([{}, { deadlineMs: 500 }])(
    "is refused rather than waited on (%j)",
    async (policy) => {
      const server = createTcpServer((socket) => {
        socket.once("data", () =>
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n",
          ),
        );
        socket.on("error", () => {});
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        await expect(safeRequest(url, { ...dev, ...policy })).rejects.toThrow(/no response/);
      } finally {
        server.close();
      }
    },
    3_000,
  );
});
