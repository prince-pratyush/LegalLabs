import { connect } from "node:net";

export type ScanResult = { clean: true } | { clean: false; signature: string };

export interface Scanner {
  scan(bytes: Uint8Array): Promise<ScanResult>;
}

/** Thrown when no verdict came back, so the file waits rather than going unscanned. */
export class ScannerUnavailable extends Error {}

export interface ClamdOptions {
  host: string;
  port?: number;
  timeoutMs?: number;
}

const CHUNK = 64 * 1024;
// The standard harmless test file every scanner flags, split so this source isn't flagged itself.
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD", "-ANTIVIRUS-TEST-FILE!$H+H*"].join(
  "",
);

/** Streams a file to clamd with INSTREAM and reads its one-line verdict. */
export function createClamdScanner(options: ClamdOptions): Scanner {
  return {
    scan: (bytes) =>
      new Promise<ScanResult>((resolve, reject) => {
        const socket = connect({ host: options.host, port: options.port ?? 3310 });
        const reply: Buffer[] = [];
        const fail = (why: string) => {
          socket.destroy();
          reject(new ScannerUnavailable(why));
        };
        socket.setTimeout(options.timeoutMs ?? 60_000, () => fail("clamd timed out"));
        socket.on("error", (err) => fail(err.name));
        socket.on("data", (data) => reply.push(data));
        socket.on("end", () => {
          const text = Buffer.concat(reply).toString("utf8").replace(/\0/g, "").trim();
          const found = /^stream: (.+) FOUND$/.exec(text);
          if (text === "stream: OK") resolve({ clean: true });
          else if (found?.[1]) resolve({ clean: false, signature: found[1].slice(0, 200) });
          // A size limit or any other error is not a verdict.
          else fail("clamd gave no verdict");
        });
        socket.on("connect", () => {
          socket.write("zINSTREAM\0");
          for (let i = 0; i < bytes.length; i += CHUNK) {
            const part = bytes.subarray(i, i + CHUNK);
            const size = Buffer.alloc(4);
            size.writeUInt32BE(part.length);
            socket.write(size);
            socket.write(part);
          }
          socket.end(Buffer.alloc(4));
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

export { EICAR };
