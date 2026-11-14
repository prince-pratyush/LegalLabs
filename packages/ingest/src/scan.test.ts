import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createClamdScanner,
  createStubScanner,
  EICAR,
  type Scanner,
  ScannerRefused,
  ScannerUnavailable,
  scannerFromEnv,
} from "./scan.js";

const encode = (text: string) => new TextEncoder().encode(text);
let server: Server | undefined;
afterEach(() => server?.close());

// Speaks just enough of clamd's INSTREAM protocol to check what the client sends.
async function fakeClamd(verdict: (body: Buffer) => string): Promise<number> {
  server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      const command = "zINSTREAM\0";
      if (buffer.length < command.length) return;
      let at = command.length;
      const parts: Buffer[] = [];
      while (at + 4 <= buffer.length) {
        const size = buffer.readUInt32BE(at);
        if (size === 0) {
          socket.end(`${verdict(Buffer.concat(parts))}\0`);
          return;
        }
        if (at + 4 + size > buffer.length) return;
        parts.push(buffer.subarray(at + 4, at + 4 + size));
        at += 4 + size;
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

const viaFake = async (verdict: (body: Buffer) => string) =>
  createClamdScanner({ host: "127.0.0.1", port: await fakeClamd(verdict), timeoutMs: 2000 });

describe("clamd scanner", () => {
  it("sends the whole file and reads a clean verdict", async () => {
    let seen = "";
    const scanner = await viaFake((body) => {
      seen = body.toString();
      return "stream: OK";
    });
    const big = "a".repeat(200_000);
    expect(await scanner.scan(encode(big))).toEqual({ clean: true });
    expect(seen).toBe(big);
  });

  it("reports the signature it found", async () => {
    const scanner = await viaFake(() => "stream: Win.Test.EICAR_HDB-1 FOUND");
    expect(await scanner.scan(encode(EICAR))).toEqual({
      clean: false,
      signature: "Win.Test.EICAR_HDB-1",
    });
  });

  it("treats an error reply as no verdict", async () => {
    const scanner = await viaFake(() => "Some error. ERROR");
    await expect(scanner.scan(encode("x"))).rejects.toBeInstanceOf(ScannerUnavailable);
  });

  it("says when a file is too big to scan, which no retry will fix", async () => {
    const scanner = await viaFake(() => "INSTREAM size limit exceeded. ERROR");
    await expect(scanner.scan(encode("x"))).rejects.toBeInstanceOf(ScannerRefused);
  });

  it("stops reading a reply that is far too long", async () => {
    const scanner = await viaFake(() => "x".repeat(5000));
    await expect(scanner.scan(encode("x"))).rejects.toBeInstanceOf(ScannerUnavailable);
  });

  it("treats a closed port as no verdict", async () => {
    const port = await fakeClamd(() => "stream: OK");
    server?.close();
    const scanner = createClamdScanner({ host: "127.0.0.1", port, timeoutMs: 2000 });
    await expect(scanner.scan(encode("x"))).rejects.toBeInstanceOf(ScannerUnavailable);
  });
});

const real = process.env.TEST_CLAMD_HOST;
describe.runIf(real)("clamd scanner against ClamAV", () => {
  const scanner: Scanner = createClamdScanner({ host: real ?? "", timeoutMs: 30_000 });

  it("passes a plain file and flags the test file", async () => {
    expect(await scanner.scan(encode("The supplier accepts liability."))).toEqual({ clean: true });
    expect(await scanner.scan(encode(EICAR))).toMatchObject({ clean: false });
  });
});

describe("stub scanner", () => {
  it("flags only the standard test file", async () => {
    const stub = createStubScanner();
    expect(await stub.scan(encode(`prefix ${EICAR}`))).toMatchObject({ clean: false });
    expect(await stub.scan(encode("contract text"))).toEqual({ clean: true });
  });
});

describe("scannerFromEnv", () => {
  it("needs a scanner, and never the stub in production", () => {
    expect(() => scannerFromEnv({})).toThrow(/CLAMAV_HOST/);
    expect(() => scannerFromEnv({ LEGALLABS_SCANNER: "stub", NODE_ENV: "production" })).toThrow();
    expect(() => scannerFromEnv({ CLAMAV_HOST: "clamav", CLAMAV_PORT: "nope" })).toThrow(/PORT/);
    expect(scannerFromEnv({ LEGALLABS_SCANNER: "stub" })).toBeTruthy();
    expect(scannerFromEnv({ CLAMAV_HOST: "clamav" })).toBeTruthy();
  });
});
