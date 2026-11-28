import { createGateway } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { createSecretBox } from "../../admin-models/secrets.js";
import { createApp } from "../../app.js";
import { createDrafts } from "../../drafts/drafts.js";
import { seedMember, testDocuments, testPool, testThreads } from "../../test-db.js";
import { createAuth } from "../auth.js";
import { createOidcProviders } from "./providers.js";
import { createOidc } from "./service.js";

// Runs against a real Zitadel (compose.zitadel.yaml + scripts/zitadel-bootstrap.mjs) and is
// skipped without ZITADEL_ISSUER. The login is driven headless through Zitadel's session API.
const env = process.env;
const enabled = Boolean(env.ZITADEL_ISSUER);

const pool = testPool();
afterAll(() => pool.end());

const json = async (url: string, body: unknown) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${env.ZITADEL_PAT}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${text}`);
  return JSON.parse(text);
};

describe.skipIf(!enabled)("sign-in against a real Zitadel", () => {
  it("completes the code flow with PKCE and opens a session for the linked user", async () => {
    const issuer = env.ZITADEL_ISSUER as string;
    const email = env.ZITADEL_USER_EMAIL as string;
    const client = { ip: "203.0.113.9", userAgent: "vitest" };
    const secrets = createSecretBox(Buffer.alloc(32, 3).toString("base64"));
    const auth = createAuth(pool);
    const app = createApp({
      auth,
      oidc: createOidc(pool, {
        baseUrl: env.ZITADEL_REDIRECT_BASE as string,
        policy: { insecureDev: true },
        secrets,
      }),
      documents: testDocuments(pool),
      threads: testThreads(pool, testDocuments(pool)),
      drafts: createDrafts(pool, {
        gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
      }),
      clientIp: () => client.ip,
    });

    // An admin sets the provider up and pre-creates the person.
    const admin = await seedMember(pool);
    await createOidcProviders(pool, { insecureDev: true, secrets }).put(
      { userId: admin.userId, workspaceId: admin.workspaceId, sessionId: "" },
      {
        issuer,
        clientId: env.ZITADEL_CLIENT_ID as string,
        enabled: true,
        linkByEmail: true,
      },
      env.ZITADEL_CLIENT_SECRET as string,
      client,
    );
    const { rows } = await pool.query<{ id: string }>(
      `insert into core."user" (workspace_id, email, status) values ($1, $2, 'invited') returning id`,
      [admin.workspaceId, email],
    );
    const userId = rows[0]?.id;

    const start = await app.request(`/auth/oidc/start?workspace=${admin.slug}`);
    expect(start.status).toBe(302);
    const authorize = start.headers.get("location") ?? "";
    expect(authorize.startsWith(issuer)).toBe(true);
    const binding = /__Host-oidc=([^;]+)/.exec(start.headers.get("set-cookie") ?? "")?.[1];

    // Zitadel answers the authorize request with a redirect to its login carrying the request id.
    const hop = await fetch(authorize, { redirect: "manual" });
    const loginUrl = new URL(hop.headers.get("location") ?? "", issuer);
    const requestId =
      loginUrl.searchParams.get("authRequest") ?? loginUrl.searchParams.get("authRequestID");
    expect(requestId, `no auth request id in ${loginUrl}`).toBeTruthy();

    const session = await json(`${issuer}/v2/sessions`, {
      checks: {
        user: { loginName: email },
        password: { password: env.ZITADEL_USER_PASSWORD },
      },
    });
    const finished = await json(`${issuer}/v2/oidc/auth_requests/${requestId}`, {
      session: { sessionId: session.sessionId, sessionToken: session.sessionToken },
    });
    const callback = new URL(finished.callbackUrl);

    const res = await app.request(`/auth/oidc/callback${callback.search}`, {
      headers: { cookie: `__Host-oidc=${binding}` },
    });
    expect(res.status).toBe(302);
    const sid = /__Host-sid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    expect(await auth.resolve(sid ?? "")).toMatchObject({ userId, workspaceId: admin.workspaceId });

    const identity = await pool.query(
      "select issuer from core.external_identity where user_id = $1",
      [userId],
    );
    expect(identity.rows[0]?.issuer).toBe(issuer);
  });
});
