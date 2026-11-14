import { once } from "node:events";
import { connect } from "node:net";

export type ScanResult = { clean: true } | { clean: false; signature: string };

export interface Scanner {
  scan(bytes: Uint8Array): Promise<ScanResult>;
}

/** Thrown when no verdict came back, so the file waits rather than going unscanned. */
export class ScannerUnavailable extends Error {}

/** Thrown when the scanner won't take a file this big, which retrying can't fix. */
export class ScannerRefused extends Error {}

export interface ClamdOptions {
  host: string;
  port?: number;
  timeoutMs?: number;
}

const CHUNK = 64 * 1024;
// A verdict is one short line; more than this is not clamd talking.
const MAX_REPLY = 1024;
// The standard harmless test file every scanner flags, split so this source isn't flagged itself.
export const EICAR = [
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD",
  "-ANTIVIRUS-TEST-FILE!$H+H*",
].join("");

/** Every byte goes to clamd, so a file is never judged on its first part alone. */
export function createClamdScanner(options: ClamdOptions): Scanner {
  return {
    scan: (bytes) =>
      new Promise<ScanResult>((resolve, reject) => {
        const socket = connect({ host: options.host, port: options.port ?? 3310 });
        const reply: Buffer[] = [];
        let replied = 0;
        const fail = (why: string, refused = false) => {
          socket.destroy();
          reject(refused ? new ScannerRefused(why) : new ScannerUnavailable(why));
        };
        socket.setTimeout(options.timeoutMs ?? 60_000, () => fail("clamd timed out"));
        socket.on("error", (err) => fail(err.name));
        socket.on("data", (data) => {
          replied += data.length;
          if (replied > MAX_REPLY) fail("clamd reply too long");
          else reply.push(data);
        });
        socket.on("end", () => {
          const text = Buffer.concat(reply).toString("utf8").replace(/\0/g, "").trim();
          const found = /^stream: (.+) FOUND$/.exec(text);
          if (text === "stream: OK") resolve({ clean: true });
          else if (found?.[1]) resolve({ clean: false, signature: found[1].slice(0, 200) });
          else if (/size limit exceeded/i.test(text)) fail("clamd size limit", true);
          // Any other error is not a verdict.
          else fail("clamd gave no verdict");
        });
        socket.on("connect", async () => {
          // Waits for the socket to drain, so a large file isn't copied into memory twice.
          const send = (data: Uint8Array | string) =>
            socket.write(data) ? Promise.resolve() : once(socket, "drain");
          try {
            await send("zINSTREAM\0");
            for (let i = 0; i < bytes.length; i += CHUNK) {
              const part = bytes.subarray(i, i + CHUNK);
              const size = Buffer.alloc(4);
              size.writeUInt32BE(part.length);
              await send(size);
              await send(part);
            }
            socket.end(Buffer.alloc(4));
          } catch {
            fail("clamd connection lost");
          }
        });
      }),
  };
}

/** For tests and small dev machines: catches only the standard test file. */
export function createStubScanner(): Scanner {
  return {
    async scan(bytes) {
      return Buffer.from(bytes).includes(EICAR)
        ? { clean: false, signature: "Eicar-Test-Signature" }
        : { clean: true };
    },
  };
}

/** A deployment must name its scanner; the stub is refused in production. */
export function scannerFromEnv(env: Record<string, string | undefined>): Scanner {
  if (env.CLAMAV_HOST) {
    const port = Number(env.CLAMAV_PORT ?? 3310);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("CLAMAV_PORT is invalid");
    return createClamdScanner({ host: env.CLAMAV_HOST, port });
  }
  if (env.LEGALLABS_SCANNER === "stub" && env.NODE_ENV !== "production") {
    return createStubScanner();
  }
  throw new Error("CLAMAV_HOST is not set (LEGALLABS_SCANNER=stub works on a dev machine only)");
}
