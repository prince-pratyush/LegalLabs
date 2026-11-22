#!/usr/bin/env node
// Bootstraps a running Zitadel (compose.zitadel-saml.yaml) for the SAML-via-Zitadel flow:
//   1. registers the test SAML IdP as a generic SAML provider (Zitadel is the SP),
//   2. enables it in the org login policy with external IdPs allowed,
//   3. creates an OIDC app (code + PKCE, no secret) for the LegalLabs app,
//   4. tells the test IdP about Zitadel's SP entity ID / ACS (plus a second, unrelated SP).
// Idempotent: a second run reuses what exists. Writes docker/zitadel-saml/bootstrap/saml.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ZITADEL = process.env.ZITADEL_SAML_ISSUER ?? "http://localhost:55436";
const PAT_FILE =
  process.env.ZITADEL_SAML_PAT_FILE ?? join(root, "docker/zitadel-saml/bootstrap/admin.pat");
// Zitadel fetches this inside the compose network; the host reaches the IdP on 55437.
const IDP_METADATA_URL =
  process.env.SAML_IDP_METADATA_URL ?? "http://saml-idp:8080/simplesaml/saml2/idp/metadata.php";
const REDIRECT_URI = process.env.SAML_APP_REDIRECT_URI ?? "http://localhost:3000/auth/callback";
const OTHER_SP = "urn:legallabs:test:other-sp";

// Zitadel writes the machine user's PAT during first-instance setup, which can lag container start.
for (let i = 0; i < 90 && !existsSync(PAT_FILE); i++) await new Promise((r) => setTimeout(r, 2000));
const pat = readFileSync(PAT_FILE, "utf8").trim();

async function api(method, path, body) {
  const res = await fetch(`${ZITADEL}${path}`, {
    method,
    headers: { authorization: `Bearer ${pat}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok)
    throw Object.assign(new Error(`${method} ${path} -> ${res.status} ${text}`), {
      status: res.status,
    });
  return json;
}

async function waitReady() {
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(`${ZITADEL}/debug/ready`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Zitadel not ready at ${ZITADEL}`);
}

await waitReady();

// 1. SAML provider
const IDP_NAME = "legallabs-test-saml-idp";
const found = await api("POST", "/management/v1/idps/templates/_search", {});
let idpId = found.result?.find((i) => i.name === IDP_NAME)?.id;
const samlBody = {
  name: IDP_NAME,
  metadataUrl: IDP_METADATA_URL,
  // The test IdP only offers HTTP-Redirect for SSO.
  binding: "SAML_BINDING_REDIRECT",
  withSignedRequest: false,
  nameIdFormat: "SAML_NAME_ID_FORMAT_EMAIL_ADDRESS",
  providerOptions: {
    isLinkingAllowed: true,
    isCreationAllowed: true,
    isAutoCreation: true,
    isAutoUpdate: true,
  },
};
if (idpId) await api("PUT", `/management/v1/idps/saml/${idpId}`, samlBody);
else idpId = (await api("POST", "/management/v1/idps/saml", samlBody)).id;

// 2. Org login policy: external IdPs allowed, SAML provider attached (this activates it).
const policy = {
  allowUsernamePassword: true,
  allowRegister: false,
  allowExternalIdp: true,
  forceMfa: false,
  passwordlessType: "PASSWORDLESS_TYPE_NOT_ALLOWED",
  hidePasswordReset: true,
};
// Zitadel answers "already exists" / "not changed" on reruns; both mean the state is right.
const settled = /already exists|AlreadyExists|NotChanged/i;
try {
  await api("POST", "/management/v1/policies/login", policy);
} catch (e) {
  if (!settled.test(e.message)) throw e;
  try {
    await api("PUT", "/management/v1/policies/login", policy);
  } catch (e2) {
    if (!settled.test(e2.message)) throw e2;
  }
}
try {
  await api("POST", "/management/v1/policies/login/idps", {
    idpId,
    ownerType: "IDP_OWNER_TYPE_ORG",
  });
} catch (e) {
  if (!/already exists|AlreadyExists|COMMAND-/i.test(e.message)) throw e;
}

// 3. OIDC app for LegalLabs (code + PKCE; dev mode allows the http redirect)
const PROJECT = "legallabs";
const projects = await api("POST", "/management/v1/projects/_search", {
  queries: [{ nameQuery: { name: PROJECT, method: "TEXT_QUERY_METHOD_EQUALS" } }],
});
let projectId = projects.result?.[0]?.id;
if (!projectId) projectId = (await api("POST", "/management/v1/projects", { name: PROJECT })).id;
const APP = "legallabs-web";
const apps = await api("POST", `/management/v1/projects/${projectId}/apps/_search`, {
  queries: [{ nameQuery: { name: APP, method: "TEXT_QUERY_METHOD_EQUALS" } }],
});
let clientId = apps.result?.[0]?.oidcConfig?.clientId;
if (!clientId) {
  const app = await api("POST", `/management/v1/projects/${projectId}/apps/oidc`, {
    name: APP,
    redirectUris: [REDIRECT_URI],
    postLogoutRedirectUris: [],
    responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
    grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
    appType: "OIDC_APP_TYPE_WEB",
    authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
    devMode: true,
  });
  clientId = app.clientId;
}

// 4. Teach the test IdP about Zitadel as an SP. Zitadel's entity ID and ACS come from its metadata.
const spMeta = await (await fetch(`${ZITADEL}/idps/${idpId}/saml/metadata`)).text();
const spEntityId = /entityID="([^"]+)"/.exec(spMeta)?.[1];
// The metadata ACS belongs to Zitadel's IdP-intent (v2 API) flow. The hosted login (v1) that
// serves OIDC clients receives SAML responses at this URL, which is also what its AuthnRequest names.
const acs = `${ZITADEL}/ui/login/login/externalidp/saml/acs`;
if (!spEntityId) throw new Error(`cannot read SP metadata: ${spMeta.slice(0, 300)}`);
const spsDir = join(root, "docker/saml-idp/dynamic");
mkdirSync(spsDir, { recursive: true });
writeFileSync(
  join(spsDir, "sps.json"),
  JSON.stringify({ [spEntityId]: acs, [OTHER_SP]: "http://localhost:9/other-sp-acs" }, null, 2),
);

const out = {
  issuer: ZITADEL,
  idpId,
  projectId,
  clientId,
  redirectUri: REDIRECT_URI,
  spEntityId,
  acs,
  otherSp: OTHER_SP,
};
writeFileSync(join(root, "docker/zitadel-saml/bootstrap/saml.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
