// Brings up a clean stack: a fresh migrated Postgres cluster, S3 storage, a
// seeded admin and the API server. Used by the pilot test, and on its own to
// run the eval suites against a real server.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { startTestDatabase } from "@legallabs/db/testing";
import { AwsClient } from "aws4fetch";
import pg from "pg";
import { startFakeModel } from "./model.mjs";

const API = fileURLToPath(new URL("..", import.meta.url));

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function waitFor(check, what, ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      if (await check()) return;
    } catch (err) {
      if (err?.fatal) throw err;
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function startStorage() {
  // CI's SeaweedFS runs without auth, so any key pair is accepted.
  if (process.env.PILOT_S3_ENDPOINT) {
    return { endpoint: process.env.PILOT_S3_ENDPOINT, key: "test", secret: "test", stop: () => {} };
  }
  const port = await freePort();
  const key = "pilot";
  const secret = randomBytes(12).toString("hex");
  // Passed by name from the environment, so the secret isn't visible in `ps`.
  const id = execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "-p",
      `127.0.0.1:${port}:9000`,
      "-e",
      "RUSTFS_ACCESS_KEY",
      "-e",
      "RUSTFS_SECRET_KEY",
      process.env.PILOT_S3_IMAGE ?? "rustfs/rustfs:latest",
    ],
    { env: { ...process.env, RUSTFS_ACCESS_KEY: key, RUSTFS_SECRET_KEY: secret } },
  )
    .toString()
    .trim();
  const endpoint = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(endpoint)).status > 0, "object storage");
  return {
    endpoint,
    key,
    secret,
    stop: () => execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" }),
  };
}

export async function startStack({ log = () => {} } = {}) {
  const stops = [];
  // In reverse and each awaited, so the server is gone before its database is.
  const stop = async () => {
    for (const fn of stops.reverse()) {
      try {
        await fn();
      } catch {}
    }
  };
  try {
    for (const file of ["dist/cli.js", "dist/server.js"]) {
      if (!existsSync(`${API}/${file}`)) {
        throw new Error(`build the API first (pnpm build): ${file} is missing`);
      }
    }
    const db = await startTestDatabase();
    stops.push(db.stop);
    const apiPassword = randomBytes(18).toString("hex");
    const owner = new pg.Client({ connectionString: db.url });
    await owner.connect();
    await owner.query(`alter role legallabs_api login password '${apiPassword}'`);
    await owner.end();
    // A shared database (CI) gets the login switched off again afterwards.
    stops.push(async () => {
      const reset = new pg.Client({ connectionString: db.url });
      await reset.connect();
      try {
        await reset.query("alter role legallabs_api nologin password null");
      } finally {
        await reset.end();
      }
    });
    // Built field by field: a password in the owner's URL must not be mistaken for the user.
    const api = new URL(db.url);
    api.username = "legallabs_api";
    api.password = apiPassword;

    const workspace = `pilot-${randomBytes(3).toString("hex")}`;
    const email = "pilot@example.test";
    const password = randomBytes(18).toString("hex");
    execFileSync(process.execPath, [`${API}/dist/cli.js`, "create-admin", workspace, email], {
      input: password,
      env: { ...process.env, DATABASE_URL: db.url },
    });

    const storage = await startStorage();
    stops.push(storage.stop);
    const bucket = "legallabs-pilot";
    const s3 = new AwsClient({
      accessKeyId: storage.key,
      secretAccessKey: storage.secret,
      region: "us-east-1",
      service: "s3",
    });
    await (await s3.fetch(`${storage.endpoint}/${bucket}`, { method: "PUT" })).body?.cancel();

    // A real local model when asked for, otherwise the scripted one.
    let modelUrl = process.env.PILOT_OLLAMA_URL;
    if (!modelUrl) {
      const fake = await startFakeModel();
      stops.push(fake.stop);
      modelUrl = fake.url;
    }

    const port = await freePort();
    const server = spawn(process.execPath, [`${API}/dist/server.js`], {
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: api.toString(),
        PORT: String(port),
        S3_ENDPOINT: storage.endpoint,
        S3_BUCKET: bucket,
        S3_ACCESS_KEY_ID: storage.key,
        S3_SECRET_ACCESS_KEY: storage.secret,
        LEGALLABS_SCANNER: "stub",
        OLLAMA_BASE_URL: modelUrl,
        LEGALLABS_MODEL_TIMEOUT_MS: process.env.LEGALLABS_MODEL_TIMEOUT_MS ?? "900000",
        ...(process.env.OLLAMA_CONTEXT_LENGTH
          ? { OLLAMA_CONTEXT_LENGTH: process.env.OLLAMA_CONTEXT_LENGTH }
          : {}),
        ...(process.env.PILOT_OLLAMA_EMBED_URL
          ? { OLLAMA_EMBED_URL: process.env.PILOT_OLLAMA_EMBED_URL }
          : {}),
        LEGALLABS_ASKS_PER_10_MIN: process.env.LEGALLABS_ASKS_PER_10_MIN ?? "1000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (d) => log(String(d)));
    server.stderr.on("data", (d) => log(String(d)));
    let exited = false;
    const gone = new Promise((resolve) =>
      server.once("exit", () => {
        exited = true;
        resolve();
      }),
    );
    stops.push(() => {
      if (!exited) server.kill("SIGTERM");
      return gone;
    });
    const url = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      // A server that crashed at boot fails the wait now, not after a minute.
      if (exited) throw Object.assign(new Error("the API exited at start"), { fatal: true });
      return (await fetch(`${url}/auth/session`)).status === 401;
    }, "the API");
    return { url, workspace, email, password, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

// `node e2e/stack.mjs` keeps a stack up and prints how to reach it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stack = await startStack({ log: (line) => process.stderr.write(line) });
  console.log(
    JSON.stringify({
      url: stack.url,
      workspace: stack.workspace,
      email: stack.email,
      password: stack.password,
    }),
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => void stack.stop().finally(() => process.exit(0)));
  }
}
