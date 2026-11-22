#!/usr/bin/env node
// Sets up the Zitadel from compose.zitadel.yaml for the OIDC integration test: a project, a web
// app (authorization code with PKCE) and a human user with a verified email. Prints KEY=value
// lines, so CI can append them to $GITHUB_ENV and a person can `export $(node ... | xargs)`.
//
//   ZITADEL_PORT       host port of the container (default 8080)
//   ZITADEL_PAT_FILE   where the first-instance PAT was written (default .zitadel/bootstrap.pat)
//   REDIRECT_BASE      public address of the API under test (default http://localhost:3000)
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const port = process.env.ZITADEL_PORT ?? "8080";
// "localhost" matches the instance's external domain, which Zitadel uses to pick the instance.
const issuer = `http://localhost:${port}`;
const patFile = process.env.ZITADEL_PAT_FILE ?? ".zitadel/bootstrap.pat";
const redirectBase = (process.env.REDIRECT_BASE ?? "http://localhost:3000").replace(/\/$/, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, probe, attempts = 90) {
  for (let i = 0; i < attempts; i++) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // Not up yet.
    }
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

await waitFor("zitadel", async () => (await fetch(`${issuer}/debug/ready`)).ok);
const pat = (
  await waitFor("the bootstrap PAT", async () => (await readFile(patFile, "utf8")).trim())
).trim();

async function api(path, body, method = "POST") {
  const res = await fetch(`${issuer}${path}`, {
    method,
    headers: { authorization: `Bearer ${pat}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} failed with ${res.status}: ${text}`);
  return JSON.parse(text);
}

// Finishing an authorization request without Zitadel's own login UI is a login client's job.
const me = (await api("/auth/v1/users/me", undefined, "GET")).user.id;
await api(`/admin/v1/members/${me}`, { roles: ["IAM_OWNER", "IAM_LOGIN_CLIENT"] }, "PUT");

const suffix = randomBytes(4).toString("hex");

const project = await api("/management/v1/projects", { name: `legallabs-${suffix}` });
const app = await api(`/management/v1/projects/${project.id}/apps/oidc`, {
  name: "legallabs-api",
  redirectUris: [`${redirectBase}/auth/oidc/callback`],
  responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
  grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
  appType: "OIDC_APP_TYPE_WEB",
  // A confidential client: the secret goes in a Basic header, PKCE is sent as well.
  authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
  // Lets the redirect be plain http, which only matters for this local instance.
  devMode: true,
  // Without this the ID token carries no email, and the first link has nothing to match.
  idTokenUserinfoAssertion: true,
});

const email = `ada-${suffix}@legallabs.test`;
const password = `Aa1!${randomBytes(9).toString("base64url")}`;
await api("/v2/users/human", {
  username: email,
  profile: { givenName: "Ada", familyName: "Tester" },
  email: { email, isVerified: true },
  password: { password, changeRequired: false },
});

const out = {
  ZITADEL_ISSUER: issuer,
  ZITADEL_PAT: pat,
  ZITADEL_CLIENT_ID: app.clientId,
  ZITADEL_CLIENT_SECRET: app.clientSecret,
  ZITADEL_REDIRECT_BASE: redirectBase,
  ZITADEL_USER_EMAIL: email,
  ZITADEL_USER_PASSWORD: password,
};
for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
