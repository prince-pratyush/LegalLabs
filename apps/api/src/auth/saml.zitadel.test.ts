// SAML via Zitadel (SEC-005): Zitadel is the SAML SP and brokers to the app over OIDC.
// Runs only against a live stack (compose.zitadel-saml.yaml + scripts/zitadel-saml-bootstrap.mjs):
//   ZITADEL_SAML_ISSUER=http://localhost:55436 pnpm vitest run --config vitest.saml.config.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  Browser,
  exchangeCode,
  type HarnessConfig,
  idpLogin,
  type Outcome,
  pkcePair,
  postToAcs,
  type SamlBootstrap,
  verifyIdToken,
  ZitadelApi,
} from "./saml-harness.js";

const issuer = process.env.ZITADEL_SAML_ISSUER;
const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const bootstrapDir =
  process.env.ZITADEL_SAML_BOOTSTRAP_DIR ?? join(root, "docker/zitadel-saml/bootstrap");

describe.skipIf(!issuer)("SAML via Zitadel", () => {
  let cfg: HarnessConfig;
  let api: ZitadelApi;

  beforeAll(async () => {
    const bootstrap = JSON.parse(
      readFileSync(join(bootstrapDir, "saml.json"), "utf8"),
    ) as SamlBootstrap;
    bootstrap.issuer = issuer as string;
    cfg = {
      bootstrap,
      idpInternal: process.env.SAML_IDP_INTERNAL_URL ?? "http://saml-idp:8080",
      idpPublic: process.env.SAML_IDP_PUBLIC_URL ?? "http://127.0.0.1:55437",
    };
    api = new ZitadelApi(cfg, readFileSync(join(bootstrapDir, "admin.pat"), "utf8").trim());

    // Users exist in Zitadel before they sign in (as after SCIM), linked to the SAML provider by
    // the IdP's NameID (its email address).
    for (const n of ["user1", "user2"]) {
      await api.call("POST", "/v2/users/human", {
        username: `${n}-saml`,
        profile: { givenName: n, familyName: "Saml" },
        email: { email: `${n}@example.com`, isVerified: true },
        idpLinks: [{ idpId: cfg.bootstrap.idpId, userId: `${n}@example.com`, userName: n }],
      });
    }
  });

  // The app asks Zitadel for an OIDC auth request, sends the browser to the SAML IdP through an
  // IdP intent, and the user signs in there. Returns the IdP's SAML response, not yet delivered.
  async function signInAtIdp(user: string, password: string) {
    const { verifier, challenge } = pkcePair();
    const authRequestId = await api.authorize(challenge);
    const authUrl = await api.startIntent();
    const browser = new Browser(cfg);
    const idpPage = await browser.request(authUrl);
    expect(idpPage.url).toContain("/simplesaml/"); // the IdP's login form, not a local password page
    const post = await idpLogin(browser, idpPage, user, password);
    return { browser, verifier, authRequestId, post };
  }

  async function finishLogin(authRequestId: string, verifier: string, intent: Outcome) {
    const session = await api.createSession(
      intent.intentId as string,
      intent.intentToken as string,
      intent.userId as string,
    );
    expect(session.status, JSON.stringify(session.json)).toBe(201);
    const done = await api.finalize(
      authRequestId,
      session.json.sessionId,
      session.json.sessionToken,
    );
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const callback = new URL(done.json.callbackUrl);
    expect(callback.searchParams.get("state")).toBe("state-1");
    const tokens = await exchangeCode(cfg, callback.searchParams.get("code") as string, verifier);
    expect(tokens.id_token, JSON.stringify(tokens)).toBeTruthy();
    return { claims: await verifyIdToken(cfg, tokens.id_token as string), session };
  }

  it("logs a SAML user in and issues an OIDC ID token for a SAML-linked identity", async () => {
    const { browser, verifier, authRequestId, post } = await signInAtIdp("user1", "user1pass");
    expect(post.action).toBe(cfg.bootstrap.acs);

    const outcome = await postToAcs(browser, cfg, post.action, post.fields);
    expect(outcome.kind, JSON.stringify(outcome)).toBe("success");
    const { claims } = await finishLogin(authRequestId, verifier, outcome);

    // The user behind the token is linked to our SAML provider, with the IdP's NameID as external id.
    const links = await api.call("POST", `/management/v1/users/${claims.sub}/idps/_search`, {});
    const link = (
      links.json.result as { idpId: string; providedUserId: string }[] | undefined
    )?.find((l) => l.idpId === cfg.bootstrap.idpId);
    expect(link, JSON.stringify(links.json)).toBeTruthy();
    expect(link?.providedUserId).toBe("user1@example.com");
  });

  it("rejects a replayed SAML response", async () => {
    const { browser, verifier, authRequestId, post } = await signInAtIdp("user2", "user2pass");
    const first = await postToAcs(browser, cfg, post.action, post.fields);
    expect(first.kind, JSON.stringify(first)).toBe("success");
    await finishLogin(authRequestId, verifier, first);

    // The same response again: in the same browser, and from one that has seen nothing.
    const again = await postToAcs(browser, cfg, post.action, post.fields);
    expect(again.kind, JSON.stringify(again)).toBe("failure");
    expect(again.body).toContain("Intent.NotStarted"); // the intent was consumed by the first response
    const elsewhere = await postToAcs(new Browser(cfg), cfg, post.action, post.fields);
    expect(elsewhere.kind, JSON.stringify(elsewhere)).toBe("failure");

    // The intent token is single use too.
    const reuse = await api.createSession(
      first.intentId as string,
      first.intentToken as string,
      first.userId as string,
    );
    expect(reuse.status, JSON.stringify(reuse.json)).toBeGreaterThanOrEqual(400);
  });

  it("rejects a response issued for another SP (wrong audience)", async () => {
    // A genuine, signed response from the IdP, addressed to a different SP entity ID.
    const attacker = new Browser(cfg);
    const otherUrl = `${cfg.idpInternal}/simplesaml/saml2/idp/SSOService.php?spentityid=${encodeURIComponent(cfg.bootstrap.otherSp)}`;
    const other = await idpLogin(attacker, await attacker.request(otherUrl), "user1", "user1pass");
    expect(other.fields.SAMLResponse).toBeTruthy();

    // A victim's intent is open at Zitadel; the foreign response is injected under its RelayState.
    const victimAuthUrl = new URL(await api.startIntent());
    const intentId = victimAuthUrl.searchParams.get("RelayState") as string;
    const res = await postToAcs(new Browser(cfg), cfg, cfg.bootstrap.acs, {
      SAMLResponse: other.fields.SAMLResponse as string,
      RelayState: intentId,
    });
    expect(res.kind, JSON.stringify(res)).toBe("failure");
    expect(res.body).toContain("ResponseInvalid");
  });
});
