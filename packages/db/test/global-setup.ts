import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { migrate } from "../src/migrate.js";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

// A private cluster keeps tests away from any Postgres already running on the machine.
async function startCluster(): Promise<{ url: string; stop: () => void }> {
  const bin = process.env.PG_BIN
    ? (name: string) => join(process.env.PG_BIN ?? "", name)
    : (name: string) => name;
  const dir = mkdtempSync(join(tmpdir(), "legallabs-pg-"));
  const port = await freePort();
  execFileSync(
    bin("initdb"),
    ["-D", dir, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale"],
    {
      stdio: "ignore",
    },
  );
  const options = `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c fsync=off -c shared_buffers=16MB`;
  // On macOS the server refuses to start without a valid LC_ALL.
  execFileSync(bin("pg_ctl"), ["-D", dir, "-o", options, "-w", "-l", join(dir, "log"), "start"], {
    stdio: "ignore",
    env: { ...process.env, LC_ALL: "C" },
  });
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop: () => {
      execFileSync(bin("pg_ctl"), ["-D", dir, "-m", "fast", "-w", "stop"], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export default async function setup(project: TestProject) {
  const external = process.env.TEST_DATABASE_URL;
  const cluster = external ? undefined : await startCluster();
  const url = external ?? cluster?.url ?? "";
  try {
    await migrate(url);
  } catch (err) {
    cluster?.stop();
    throw err;
  }
  project.provide("databaseUrl", url);
  return () => cluster?.stop();
}
