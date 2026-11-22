import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

// A throwaway OpenID provider for tests: discovery, keys and a token endpoint, nothing else.

export interface Tweaks {
  iss?: string;
  aud?: string | string[];
  /** "none" and "HS256" make an unsafe token the client must refuse. */
  alg?: "RS256" | "ES256" | "HS256" | "none";
  /** Seconds from now; negative for an expired token. */
  expiresIn?: number;
  nonce?: string;
  /** Signs with a key the JWKS does not publish. */
  foreignKey?: boolean;
}

interface Pending {
  nonce: string;
  challenge: string;
  claims: Record<string, unknown>;
  tweaks: Tweaks;
  used: boolean;
}

export interface MockIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Plays the user signing in at the IdP: returns the code it would redirect back with. */
  authorize(authUrl: string, claims: Record<string, unknown>, tweaks?: Tweaks): string;
  /** Publishes a fresh key and signs with it from now on. */
  rotateKey(): Promise<void>;
  metadata: Record<string, unknown>;
  hits: { discovery: number; jwks: number };
  close(): Promise<void>;
}

const b64 = (s: Buffer | string) => Buffer.from(s).toString("base64url");

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startMockIdp(): Promise<MockIdp> {
  const clientId = "legallabs-test";
  const clientSecret = randomBytes(16).toString("hex");
  const pending = new Map<string, Pending>();
  const hits = { discovery: 0, jwks: 0 };
  let kid = 1;
  let signing = await generateKeyPair("RS256", { extractable: true });
  const published: JWK[] = [];
  const publish = async () => {
    published.push({
      ...(await exportJWK(signing.publicKey)),
      kid: `k${kid}`,
      alg: "RS256",
      use: "sig",
    });
  };
  await publish();
  const foreign = await generateKeyPair("RS256");

  let issuer = "";
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      hits.discovery += 1;
      return send(200, idp.metadata);
    }
    if (url.pathname === "/jwks") {
      hits.jwks += 1;
      return send(200, { keys: published });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const basic = req.headers.authorization?.startsWith("Basic ")
        ? Buffer.from(req.headers.authorization.slice(6), "base64").toString()
        : "";
      if (basic !== `${clientId}:${clientSecret}`) return send(401, { error: "invalid_client" });
      const code = form.get("code") ?? "";
      const entry = pending.get(code);
      // A code works once; a second try is the replay the client must survive.
      if (!entry || entry.used || form.get("grant_type") !== "authorization_code") {
        return send(400, { error: "invalid_grant" });
      }
      entry.used = true;
      const verifier = form.get("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) {
        return send(400, { error: "invalid_grant" });
      }
      const t = entry.tweaks;
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        sub: "sub-1",
        ...entry.claims,
        nonce: t.nonce ?? entry.nonce,
      };
      const base = new SignJWT(payload)
        .setIssuer(t.iss ?? issuer)
        .setAudience(t.aud ?? clientId)
        .setIssuedAt(now)
        .setExpirationTime(now + (t.expiresIn ?? 300));
      let idToken: string;
      if (t.alg === "none") {
        const head = b64(JSON.stringify({ alg: "none", typ: "JWT" }));
        const body = b64(
          JSON.stringify({
            ...payload,
            iss: t.iss ?? issuer,
            aud: t.aud ?? clientId,
            iat: now,
            exp: now + (t.expiresIn ?? 300),
          }),
        );
        idToken = `${head}.${body}.`;
      } else if (t.alg === "HS256") {
        // Signed with the client secret: what a forger who knew it could do.
        idToken = await base
          .setProtectedHeader({ alg: "HS256", kid: `k${kid}` })
          .sign(new TextEncoder().encode(clientSecret));
      } else {
        const key = t.foreignKey ? foreign.privateKey : signing.privateKey;
        idToken = await base.setProtectedHeader({ alg: "RS256", kid: `k${kid}` }).sign(key);
      }
      return send(200, { access_token: "unused", token_type: "Bearer", id_token: idToken });
    }
    send(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const idp: MockIdp = {
    issuer,
    clientId,
    clientSecret,
    hits,
    metadata: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      code_challenge_methods_supported: ["S256"],
      id_token_signing_alg_values_supported: ["RS256"],
    },
    authorize(authUrl, claims, tweaks = {}) {
      const u = new URL(authUrl);
      if (u.searchParams.get("code_challenge_method") !== "S256") throw new Error("S256 only");
      const code = randomBytes(16).toString("hex");
      pending.set(code, {
        nonce: u.searchParams.get("nonce") ?? "",
        challenge: u.searchParams.get("code_challenge") ?? "",
        claims,
        tweaks,
        used: false,
      });
      return code;
    },
    async rotateKey() {
      kid += 1;
      signing = await generateKeyPair("RS256", { extractable: true });
      await publish();
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return idp;
}
