// Brings up a clean stack: a fresh migrated Postgres cluster, S3 storage, a
// seeded admin and the API server serving the web build. Used by the pilot
// test and to run the eval suites against a real server.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
    } catch {}
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// CI passes its own S3 (SeaweedFS); elsewhere a throwaway container is started.
async function startStorage() {
  if (process.env.PILOT_S3_ENDPOINT) {
    return { endpoint: process.env.PILOT_S3_ENDPOINT, key: "test", secret: "test", stop: () => {} };
  }
  const port = await freePort();
  const key = "pilot";
  const secret = randomBytes(12).toString("hex");
  const id = execFileSync("docker", [
    "run", "-d", "--rm", "-p", `127.0.0.1:${port}:9000`,
    "-e", `RUSTFS_ACCESS_KEY=${key}`, "-e", `RUSTFS_SECRET_KEY=${secret}`,
    process.env.PILOT_S3_IMAGE ?? "rustfs/rustfs:latest",
  ]).toString().trim();
  const endpoint = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(endpoint)).status > 0, "object storage");
  return { endpoint, key, secret, stop: () => execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" }) };
}

export async function startStack({ log = () => {} } = {}) {
  const stops = [];
  const stop = () => {
    for (const fn of stops.reverse()) {
      try {
        fn();
      } catch {}
    }
  };
  try {
    const db = await startTestDatabase();
    stops.push(db.stop);
    const apiPassword = randomBytes(18).toString("hex");
    const owner = new pg.Client({ connectionString: db.url });
    await owner.connect();
    await owner.query(`alter role legallabs_api login password '${apiPassword}'`);
    await owner.end();
    const apiUrl = db.url.replace("postgres@", `legallabs_api:${apiPassword}@`);

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
    const s3 = new AwsClient({ accessKeyId: storage.key, secretAccessKey: storage.secret, region: "us-east-1", service: "s3" });
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
        DATABASE_URL: apiUrl,
        PORT: String(port),
        S3_ENDPOINT: storage.endpoint,
        S3_BUCKET: bucket,
        S3_ACCESS_KEY_ID: storage.key,
        S3_SECRET_ACCESS_KEY: storage.secret,
        LEGALLABS_SCANNER: "stub",
        OLLAMA_BASE_URL: modelUrl,
        LEGALLABS_MODEL_TIMEOUT_MS: process.env.LEGALLABS_MODEL_TIMEOUT_MS ?? "900000",
        ...(process.env.OLLAMA_CONTEXT_LENGTH ? { OLLAMA_CONTEXT_LENGTH: process.env.OLLAMA_CONTEXT_LENGTH } : {}),
        ...(process.env.PILOT_OLLAMA_EMBED_URL ? { OLLAMA_EMBED_URL: process.env.PILOT_OLLAMA_EMBED_URL } : {}),
        LEGALLABS_ASKS_PER_10_MIN: process.env.LEGALLABS_ASKS_PER_10_MIN ?? "1000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (d) => log(String(d)));
    server.stderr.on("data", (d) => log(String(d)));
    stops.push(() => server.kill("SIGTERM"));
    const url = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await fetch(`${url}/auth/session`)).status === 401, "the API");
    return { url, workspace, email, password, stop };
  } catch (err) {
    stop();
    throw err;
  }
}

// `node e2e/stack.mjs` keeps a stack up and prints how to reach it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stack = await startStack({ log: (line) => process.stderr.write(line) });
  console.log(JSON.stringify({ url: stack.url, workspace: stack.workspace, email: stack.email, password: stack.password }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stack.stop(); process.exit(0); });
}
