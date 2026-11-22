# SAML via Zitadel

The app does not implement SAML (06-security-compliance 3.1, ADR-012). A customer's SAML-only IdP
connects to the bundled Zitadel, which is the SAML service provider and speaks OIDC to the app.
Zitadel is AGPL and a separate service, so the licence boundary stays clean.

## How it works

1. The app's sign-in service asks Zitadel for an OIDC auth request (code + PKCE, no client secret).
2. It starts an IdP intent for the SAML provider (`POST /v2/idp_intents`); Zitadel returns the IdP's
   SSO URL carrying a SAML AuthnRequest, with the intent ID as RelayState.
3. The user signs in at the IdP. The IdP posts a signed SAML response to Zitadel's ACS.
4. Zitadel validates it and redirects to the app with an intent ID, token and the linked user.
5. The app creates a Zitadel session from the intent, finalizes the auth request with it, and gets
   back the OIDC redirect with a code, then exchanges the code and validates the ID token.

Users are linked to the provider by the IdP's NameID (here the email address). The test IdP sends no
name attributes, so users are provisioned (or SCIM-created) in Zitadel before first sign-in; the
provider has auto-update off so an empty attribute set cannot blank a profile.

## Local stack

```sh
LOCAL_UID=$(id -u) LOCAL_GID=$(id -g) docker compose -f compose.zitadel-saml.yaml up -d
node scripts/zitadel-saml-bootstrap.mjs      # waits for Zitadel, then configures it
ZITADEL_SAML_ISSUER=http://localhost:55436 \
  pnpm --filter @legallabs/api exec vitest run --config vitest.saml.config.ts
```

- Zitadel `localhost:55436`, test IdP `127.0.0.1:55437` (simpleSAMLphp, `kristophjunge/test-saml-idp`;
  amd64 image, runs emulated and slowly on arm64). Users: `user1/user1pass`, `user2/user2pass`.
- The bootstrap registers the SAML provider from the IdP's metadata URL, adds it to the org login
  policy with external IdPs allowed, creates the OIDC app, turns on the login-v2 model so the app owns
  the sign-in UI, gives the machine user the `IAM_LOGIN_CLIENT` role, and tells the IdP about Zitadel
  as an SP (plus a second, unrelated SP used for the audience test). It is safe to rerun.
- CI runs the same steps in the `identity-saml` job. Without `ZITADEL_SAML_ISSUER` the test is skipped.

## What is verified

`apps/api/src/auth/saml.zitadel.test.ts` drives the flow headlessly with plain `fetch` and a cookie jar:

- A SAML login succeeds: signed response accepted, session created, ID token verified (RS256
  signature against the JWKS, issuer, audience, expiry), and the token's user is linked to the SAML
  provider with the IdP's NameID as external ID.
- A replayed SAML response is refused, in the same browser and in a fresh one
  (`Errors.Intent.NotStarted`), and the intent token cannot start a second session.
- A genuine response the IdP signed for a different SP, injected under a live intent, is refused
  (`Errors.Intent.ResponseInvalid`).

## Limits

- Replay is stopped by Zitadel's single-use intent, not observed as an assertion-ID cache. A response
  replayed against a fresh, still-open intent was not tested.
- Time-window (NotOnOrAfter) rejection is not tested; the test IdP cannot issue stale assertions.
- The ID token is checked with `node:crypto`, not `jose`, because `jose` is not a dependency of this
  branch.
- Attribute-based provisioning (names, groups) needs a Zitadel Action; not covered here.
