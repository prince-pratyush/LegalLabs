// Headless browser stand-in for the SAML-via-Zitadel test: plain fetch, a cookie jar,
// manual redirects. Not used by the app; only by saml.zitadel.test.ts.
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

export interface SamlBootstrap {
  issuer: string;
  idpId: string;
  clientId: string;
  redirectUri: string;
  spEntityId: string;
  acs: string;
  otherSp: string;
}

export interface HarnessConfig {
  bootstrap: SamlBootstrap;
  // Zitadel reaches the IdP as saml-idp:8080 inside compose; the host uses a published port.
  idpInternal: string;
  idpPublic: string;
}

export class CookieJar {
  private cookies = new Map<string, string>();

  store(host: string, res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(`${host}|${pair.slice(0, i)}`, pair.slice(i + 1));
    }
  }

  header(host: string): string {
    return [...this.cookies]
      .filter(([k]) => k.startsWith(`${host}|`))
      .map(([k, v]) => `${k.slice(host.length + 1)}=${v}`)
      .join("; ");
  }
}

export interface Page {
  url: string;
  status: number;
  body: string;
}

export class Browser {
  readonly jar = new CookieJar();
  constructor(private cfg: HarnessConfig) {}

  private rewrite(url: string): string {
    return url.startsWith(this.cfg.idpInternal)
      ? this.cfg.idpPublic + url.slice(this.cfg.idpInternal.length)
      : url;
  }

  // Follows redirects until `stopAt` matches the next Location (returned as `location`) or a non-redirect.
  async request(
    url: string,
    init: { method?: string; form?: Record<string, string> } = {},
    stopAt?: (loc: string) => boolean,
  ): Promise<Page & { location?: string }> {
    let current = url;
    let method = init.method ?? (init.form ? "POST" : "GET");
    let form = init.form;
    for (let hop = 0; hop < 20; hop++) {
      const target = this.rewrite(current);
      const host = new URL(target).host;
      const res = await fetch(target, {
        method,
        redirect: "manual",
        headers: {
          cookie: this.jar.header(host),
          ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      });
      this.jar.store(host, res);
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        const next = new URL(loc, current).toString();
        if (stopAt?.(next)) return { url: current, status: res.status, body: "", location: next };
        current = next;
        method = "GET";
        form = undefined;
        continue;
      }
      return { url: current, status: res.status, body: await res.text() };
    }
    throw new Error(`too many redirects from ${url}`);
  }
}

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

const decode = (s: string) =>
  s
    .replace(/&#43;/g, "+")
    .replace(/&#x2B;/gi, "+")
    .replace(/&#61;/g, "=")
    .replace(/&#x3D;/gi, "=")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');

export function parseForm(html: string): { action: string; fields: Record<string, string> } {
  const form = /<form[^>]*>/i.exec(html)?.[0];
  if (!form) throw new Error(`no form in page: ${html.slice(0, 300)}`);
  const action = decode(/action="([^"]*)"/i.exec(form)?.[1] ?? "");
  const fields: Record<string, string> = {};
  for (const input of html.match(/<input[^>]*>/gi) ?? []) {
    const name = /name="([^"]*)"/i.exec(input)?.[1];
    if (!name) continue;
    fields[name] = decode(/value="([^"]*)"/i.exec(input)?.[1] ?? "");
  }
  return { action, fields };
}

// What the app's login service does with Zitadel's API: Zitadel hands out an auth request for
// the OIDC client, an IdP intent for the SAML round trip, and a session that finishes the request.
export class ZitadelApi {
  constructor(
    private cfg: HarnessConfig,
    private pat: string,
  ) {}

  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.cfg.bootstrap.issuer}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.pat}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: Zitadel's JSON is only probed, not modelled.
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
  }

  // OIDC authorize request (code + PKCE); Zitadel answers with a redirect carrying the auth request ID.
  async authorize(challenge: string, state = "state-1"): Promise<string> {
    const q = new URLSearchParams({
      client_id: this.cfg.bootstrap.clientId,
      redirect_uri: this.cfg.bootstrap.redirectUri,
      response_type: "code",
      scope: "openid profile email",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const res = await fetch(`${this.cfg.bootstrap.issuer}/oauth/v2/authorize?${q}`, {
      redirect: "manual",
    });
    const id = new URL(res.headers.get("location") ?? "http://x/").searchParams.get("authRequest");
    if (!id)
      throw new Error(
        `authorize gave no auth request: ${res.status} ${res.headers.get("location")}`,
      );
    return id;
  }

  async startIntent(): Promise<string> {
    const { json } = await this.call("POST", "/v2/idp_intents", {
      idpId: this.cfg.bootstrap.idpId,
      urls: { successUrl: successUrl(this.cfg), failureUrl: failureUrl(this.cfg) },
    });
    if (!json.authUrl) throw new Error(`no authUrl: ${JSON.stringify(json)}`);
    return json.authUrl as string;
  }

  createSession(id: string, token: string, userId: string) {
    return this.call("POST", "/v2/sessions", {
      checks: {
        user: { userId },
        idpIntent: { idpIntentId: id, idpIntentToken: token },
      },
    });
  }

  finalize(authRequestId: string, sessionId: string, sessionToken: string) {
    return this.call("POST", `/v2/oidc/auth_requests/${authRequestId}`, {
      session: { sessionId, sessionToken },
    });
  }
}

// Where Zitadel sends the browser after the IdP round trip. Nothing listens there.
export const successUrl = (cfg: HarnessConfig) =>
  `${new URL(cfg.bootstrap.redirectUri).origin}/idp-success`;
export const failureUrl = (cfg: HarnessConfig) =>
  `${new URL(cfg.bootstrap.redirectUri).origin}/idp-failure`;

// Walks the redirects into the IdP's login form and submits the test user's credentials.
// Returns the auto-post page the IdP sends back: SAMLResponse + RelayState for the ACS.
export async function idpLogin(browser: Browser, loginPage: Page, user: string, password: string) {
  const form = parseForm(loginPage.body);
  const action = new URL(form.action, loginPage.url).toString();
  const res = await browser.request(action, {
    form: { ...form.fields, username: user, password },
  });
  const post = parseForm(res.body);
  if (!post.fields.SAMLResponse) throw new Error(`IdP login failed: ${res.body.slice(0, 400)}`);
  return post;
}

export interface Outcome {
  kind: "success" | "failure" | "page";
  intentId?: string | undefined;
  intentToken?: string | undefined;
  userId?: string | undefined;
  status: number;
  body: string;
}

// Posts a SAMLResponse (with its RelayState, the intent ID) to Zitadel's ACS and reports where
// Zitadel sends the browser: the success URL carries the intent ID and token, the failure URL
// or an error page means the response was refused.
export async function postToAcs(
  browser: Browser,
  cfg: HarnessConfig,
  acs: string,
  fields: Record<string, string>,
): Promise<Outcome> {
  const ok = successUrl(cfg);
  const bad = failureUrl(cfg);
  const res = await browser.request(
    acs,
    { form: fields },
    (loc) => loc.startsWith(ok) || loc.startsWith(bad),
  );
  if (res.location?.startsWith(ok)) {
    const u = new URL(res.location);
    return {
      kind: "success",
      intentId: u.searchParams.get("id") ?? undefined,
      intentToken: u.searchParams.get("token") ?? undefined,
      userId: u.searchParams.get("user") ?? undefined,
      status: res.status,
      body: "",
    };
  }
  if (res.location) return { kind: "failure", status: res.status, body: res.location };
  const text = res.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  return { kind: "page", status: res.status, body: text.slice(0, 400) };
}

export async function exchangeCode(cfg: HarnessConfig, code: string, verifier: string) {
  const res = await fetch(`${cfg.bootstrap.issuer}/oauth/v2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.bootstrap.redirectUri,
      client_id: cfg.bootstrap.clientId,
      code_verifier: verifier,
    }),
  });
  const json = (await res.json()) as { id_token?: string; access_token?: string; error?: string };
  return { status: res.status, ...json };
}

// RS256 ID token check against the issuer's JWKS: signature, iss, aud, exp. No jose in this
// package's dependencies, and node:crypto covers what Zitadel signs with.
export async function verifyIdToken(cfg: HarnessConfig, idToken: string) {
  const [h, p, s] = idToken.split(".");
  if (!h || !p || !s) throw new Error("malformed id_token");
  const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg: string; kid: string };
  const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
  if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);
  const jwks = (await (await fetch(`${cfg.bootstrap.issuer}/oauth/v2/keys`)).json()) as {
    keys: ({ kid: string } & Record<string, unknown>)[];
  };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("signing key not in JWKS");
  const ok = verify(
    "RSA-SHA256",
    Buffer.from(`${h}.${p}`),
    createPublicKey({ key: jwk as never, format: "jwk" }),
    Buffer.from(s, "base64url"),
  );
  if (!ok) throw new Error("bad id_token signature");
  if (claims.iss !== cfg.bootstrap.issuer) throw new Error(`bad iss ${String(claims.iss)}`);
  const aud = ([] as unknown[]).concat(claims.aud);
  if (!aud.includes(cfg.bootstrap.clientId)) throw new Error("bad aud");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) throw new Error("expired");
  return claims;
}
