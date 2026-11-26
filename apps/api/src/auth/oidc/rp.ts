import { createLocalJWKSet, errors, type JSONWebKeySet, jwtVerify } from "jose";
import { type FetchPolicy, safeRequest } from "../../net/fetch.js";

const HOUR_MS = 60 * 60 * 1000;
// Asymmetric only: "none" and the HS family would let a token vouch for itself.
export const ID_TOKEN_ALGS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
];

export interface Metadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  code_challenge_methods_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
}

export class RpError extends Error {
  constructor(
    readonly reason: string,
    message = reason,
  ) {
    super(message);
  }
}

interface Cached<T> {
  value: T;
  at: number;
}

export interface Rp {
  metadata(issuer: string): Promise<Metadata>;
  verifyIdToken(
    idToken: string,
    expect: { issuer: string; clientId: string; nonce: string; jwksUri: string },
  ): Promise<Record<string, unknown>>;
  exchangeCode(
    meta: Metadata,
    params: {
      code: string;
      verifier: string;
      redirectUri: string;
      clientId: string;
      clientSecret: string | null;
    },
  ): Promise<string>;
}

const isHttpUrl = (value: unknown, insecureDev: boolean): value is string => {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "https:" || (insecureDev && protocol === "http:");
};

export function createRp(opts: { policy?: FetchPolicy; now?: () => number } = {}): Rp {
  const policy = opts.policy ?? {};
  const now = opts.now ?? Date.now;
  const insecureDev = policy.insecureDev ?? false;
  const metadataCache = new Map<string, Cached<Metadata>>();
  const keyCache = new Map<string, Cached<JSONWebKeySet>>();

  const getJson = async (url: string): Promise<unknown> => {
    const res = await safeRequest(url, policy);
    if (res.status !== 200) throw new RpError("fetch_failed", `HTTP ${res.status}`);
    try {
      return JSON.parse(res.body);
    } catch {
      throw new RpError("fetch_failed", "not JSON");
    }
  };

  const metadata: Rp["metadata"] = async (issuer) => {
    const hit = metadataCache.get(issuer);
    if (hit && now() - hit.at < HOUR_MS) return hit.value;
    const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const doc = (await getJson(url)) as Partial<Metadata> | null;
    // Mix-up defence: the document must name the issuer we asked about.
    if (!doc || doc.issuer !== issuer) throw new RpError("issuer_mismatch");
    if (
      !isHttpUrl(doc.authorization_endpoint, insecureDev) ||
      !isHttpUrl(doc.token_endpoint, insecureDev) ||
      !isHttpUrl(doc.jwks_uri, insecureDev)
    ) {
      throw new RpError("bad_metadata");
    }
    const methods = doc.code_challenge_methods_supported;
    if (methods && !methods.includes("S256")) throw new RpError("pkce_unsupported");
    const value = doc as Metadata;
    metadataCache.set(issuer, { value, at: now() });
    return value;
  };

  const keys = async (jwksUri: string, refresh: boolean): Promise<JSONWebKeySet> => {
    const hit = keyCache.get(jwksUri);
    if (!refresh && hit && now() - hit.at < HOUR_MS) return hit.value;
    const set = (await getJson(jwksUri)) as JSONWebKeySet;
    if (!set || !Array.isArray(set.keys)) throw new RpError("bad_jwks");
    keyCache.set(jwksUri, { value: set, at: now() });
    return set;
  };

  const verify = (idToken: string, set: JSONWebKeySet, e: Parameters<Rp["verifyIdToken"]>[1]) =>
    jwtVerify(idToken, createLocalJWKSet(set), {
      issuer: e.issuer,
      audience: e.clientId,
      algorithms: ID_TOKEN_ALGS,
      requiredClaims: ["exp", "iat", "sub"],
      clockTolerance: 30,
    });

  return {
    metadata,

    async verifyIdToken(idToken, expect) {
      let payload: Record<string, unknown>;
      try {
        try {
          ({ payload } = await verify(idToken, await keys(expect.jwksUri, false), expect));
        } catch (err) {
          // A new kid usually means the IdP rotated keys: look again at once, only that once.
          if (!(err instanceof errors.JWKSNoMatchingKey)) throw err;
          ({ payload } = await verify(idToken, await keys(expect.jwksUri, true), expect));
        }
      } catch (err) {
        if (err instanceof RpError) throw err;
        const claim = err instanceof errors.JWTClaimValidationFailed ? err.claim : undefined;
        const code = err instanceof errors.JOSEError ? err.code : "ERR_UNKNOWN";
        throw new RpError("id_token_invalid", claim ? `${code}:${claim}` : code);
      }
      if (payload.nonce !== expect.nonce) throw new RpError("nonce_mismatch");
      if (typeof payload.sub !== "string" || payload.sub === "") throw new RpError("bad_subject");
      if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== expect.clientId) {
        throw new RpError("id_token_invalid", "azp");
      }
      // jose only checks iat against a max age; one from the future is not credible.
      if (typeof payload.iat !== "number" || payload.iat * 1000 > now() + 60_000) {
        throw new RpError("id_token_invalid", "iat");
      }
      return payload;
    },

    async exchangeCode(meta, p) {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: p.code,
        redirect_uri: p.redirectUri,
        code_verifier: p.verifier,
      });
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
      };
      if (p.clientSecret) {
        const basic = Buffer.from(
          `${encodeURIComponent(p.clientId)}:${encodeURIComponent(p.clientSecret)}`,
        ).toString("base64");
        headers.authorization = `Basic ${basic}`;
      } else {
        body.set("client_id", p.clientId);
      }
      const res = await safeRequest(meta.token_endpoint, policy, {
        method: "POST",
        headers,
        body: body.toString(),
      });
      if (res.status !== 200) throw new RpError("token_exchange_failed", `HTTP ${res.status}`);
      let parsed: { id_token?: unknown };
      try {
        parsed = JSON.parse(res.body);
      } catch {
        throw new RpError("token_exchange_failed", "not JSON");
      }
      if (typeof parsed.id_token !== "string")
        throw new RpError("token_exchange_failed", "no id_token");
      return parsed.id_token;
    },
  };
}
