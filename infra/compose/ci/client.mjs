// A signed-in client for the CI checks: through the proxy, over TLS, as a browser would, with
// an Origin header and a second factor. Needs NODE_EXTRA_CA_CERTS for a self-signed server.
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const BASE = process.env.SMOKE_URL ?? "https://localhost";
const { WORKSPACE, ADMIN_EMAIL, ADMIN_PASSWORD, TOTP_FILE } = process.env;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function totp(secret) {
  let bits = "";
  for (const c of secret) bits += BASE32.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[19] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export async function until(read, done, what, ms = 300_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined && done(value)) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

export async function signIn() {
  const jar = new Map();
  const call = async (path, init = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: AbortSignal.timeout(120_000),
      headers: {
        origin: BASE,
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}),
      },
    });
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";")[0];
      jar.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
    }
    return res;
  };
  const json = async (path, init = {}, status = 200) => {
    const res = await call(path, init);
    if (res.status !== status) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  const post = (path, body, status = 200) =>
    json(path, { method: "POST", body: JSON.stringify(body) }, status);

  const login = await post("/auth/login", {
    workspace: WORKSPACE,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (login.mfa_enrolment_required) {
    // A new administrator must set up a second factor before there is a session.
    const { secret } = await post("/auth/mfa/enrol/totp/begin", {});
    await post("/auth/mfa/enrol/totp/confirm", { code: totp(secret) });
    if (TOTP_FILE) writeFileSync(TOTP_FILE, secret, { mode: 0o600 });
  } else if (login.mfa_required) {
    if (!TOTP_FILE || !existsSync(TOTP_FILE)) throw new Error("no second factor to hand");
    const secret = readFileSync(TOTP_FILE, "utf8");
    // A code is refused the second time, and wrong ones are counted against the sign-in, so
    // wait for a fresh one and send it once.
    await new Promise((resolve) => setTimeout(resolve, 31_000 - (Date.now() % 30_000)));
    await post("/auth/mfa/totp", { code: totp(secret) });
  } else {
    throw new Error("an administrator signed in with a password alone");
  }
  await json("/auth/session");

  async function upload(vaultId, name, bytes, type) {
    const form = new FormData();
    form.set("file", new File([bytes], name, { type }));
    const { file } = await json(
      `/api/v1/vaults/${vaultId}/files`,
      { method: "POST", body: form },
      202,
    );
    return until(
      async () =>
        (await json(`/api/v1/vaults/${vaultId}/tree`)).files.find((f) => f.id === file.id),
      (f) => f.state === "ready" || f.state === "failed",
      `${name} to be read`,
    );
  }

  /** Asks over one vault and returns the whole event stream. */
  async function ask(vaultId, content) {
    const asked = await post(
      "/api/v1/threads",
      { content, scope: { document_ids: [], vault_ids: [vaultId], sources: [] } },
      202,
    );
    const stream = await (await call(`/api/v1/runs/${asked.run_id}/events`)).text();
    return { threadId: asked.thread_id, stream };
  }

  return { call, json, post, upload, ask };
}
