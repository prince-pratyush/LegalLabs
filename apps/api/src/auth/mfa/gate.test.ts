import { randomBytes } from "node:crypto";
import { createGateway } from "@legallabs/model-gateway";
import { createMemoryStore } from "@legallabs/storage";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { createDrafts } from "../../drafts/drafts.js";
import { createRetention } from "../../retention/service.js";
import { createSpaceModule } from "../../spaces/module.js";
import { scriptedTaskRuns } from "../../spaces/ports.js";
import { PASSWORD, seedMember, testDocuments, testPool, testThreads } from "../../test-db.js";
import { createVaults } from "../../vaults/vaults.js";
import { createAuth } from "../auth.js";
import { isStepUpAction } from "./gate.js";
import { createMfa } from "./service.js";

/*
 * Pen-test P-08 (SEC-007): a stolen session that has not shown a second factor recently must not
 * be able to weaken retention, place or lift a legal hold, or add a guest organisation.
 */

const pool = testPool();
afterAll(() => pool.end());

const ZERO = "00000000-0000-0000-0000-000000000000";
const client = { ip: "203.0.113.9", userAgent: "vitest" };

async function world(enrolFactor: boolean) {
  const store = createMemoryStore();
  const documents = testDocuments(pool, { store });
  const mfa = createMfa(pool, {
    rpID: "legal.test",
    rpName: "LegalLabs",
    origins: ["https://legal.test"],
    encryptionKey: randomBytes(32),
  });
  const auth = createAuth(pool);
  const app = createApp({
    auth,
    mfa,
    documents,
    threads: testThreads(pool, documents),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
    }),
    vaults: createVaults(pool, { documents, store }),
    spaces: createSpaceModule(pool, { runs: scriptedTaskRuns() }),
    retention: createRetention(pool, { store, notifications: { notify: async () => {} } }),
    clientIp: () => client.ip,
  });
  const admin = await seedMember(pool);
  if (enrolFactor) {
    await pool.query(
      `insert into core.mfa_totp (workspace_id, user_id, secret_enc, confirmed_at)
       values ($1, $2, decode(repeat('11', 40), 'hex'), now())`,
      [admin.workspaceId, admin.userId],
    );
  }
  // A session that never showed a factor, as a stolen cookie would be.
  const login = await auth.login(
    { workspace: admin.slug, email: admin.email, password: PASSWORD },
    client,
  );
  if (!login) throw new Error("sign-in failed");
  const cookie = `__Host-sid=${login.token}`;
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const fresh = () =>
    pool.query("update core.session set mfa_at = now() where id = $1", [login.principal.sessionId]);
  return { admin, call, fresh };
}

const actions = () => ({
  policy: ["PUT", "/admin/retention/policy", { scope: "workspace", hours: 72 }] as const,
  clear: ["DELETE", "/admin/retention/policy?scope=workspace"] as const,
  hold: [
    "PUT",
    "/admin/retention/holds",
    { object_type: "matter", object_id: ZERO, held: true, reason: "case" },
  ] as const,
  party: [
    "POST",
    `/spaces/${ZERO}/parties`,
    { name: "Other LLP", domain: "other.test", admin_emails: ["a@other.test"] },
  ] as const,
});

describe("P-08 step-up on sensitive admin actions", () => {
  it("lists exactly the actions SEC-007 names that this API has", () => {
    expect(isStepUpAction("PUT", "/api/v1/admin/retention/policy")).toBe(true);
    expect(isStepUpAction("DELETE", "/api/v1/admin/retention/policy")).toBe(true);
    expect(isStepUpAction("PUT", "/api/v1/admin/retention/holds")).toBe(true);
    expect(isStepUpAction("POST", `/api/v1/spaces/${ZERO}/parties`)).toBe(true);
    expect(isStepUpAction("PUT", "/api/v1/admin/identity/sso")).toBe(true);
    expect(isStepUpAction("GET", "/api/v1/admin/identity/sso")).toBe(false);
    // Who is in the workspace and what they may do.
    expect(isStepUpAction("PATCH", `/api/v1/admin/users/${ZERO}`)).toBe(true);
    expect(isStepUpAction("POST", "/api/v1/admin/users/invite")).toBe(true);
    expect(isStepUpAction("POST", `/api/v1/admin/users/${ZERO}/invite`)).toBe(true);
    expect(isStepUpAction("POST", "/api/v1/admin/roles")).toBe(true);
    expect(isStepUpAction("GET", "/api/v1/admin/users")).toBe(false);
    expect(isStepUpAction("GET", "/api/v1/admin/roles")).toBe(false);
    expect(isStepUpAction("DELETE", `/api/v1/admin/users/${ZERO}/identities`)).toBe(true);
    expect(isStepUpAction("GET", "/api/v1/admin/retention/policy")).toBe(false);
    expect(isStepUpAction("GET", "/api/v1/admin/retention")).toBe(false);
  });

  it("refuses each with MFA_REQUIRED on a session that has not shown a factor", async () => {
    const w = await world(true);
    const a = actions();
    for (const [method, path, body] of [a.policy, a.clear, a.hold, a.party] as const) {
      const res = await w.call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.code).toBe("MFA_REQUIRED");
    }
    // Nothing was written.
    const rows = await pool.query(
      "select count(*)::int as n from retention.policy where workspace_id = $1",
      [w.admin.workspaceId],
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("lets them through once a factor was shown, and reads never need one", async () => {
    const w = await world(true);
    const a = actions();
    expect((await w.call("GET", "/admin/retention")).status).toBe(200);
    await w.fresh();
    const policy = await w.call(...a.policy);
    expect(policy.status).toBe(200);
    expect((await w.call(...a.hold)).status).not.toBe(403);
    // Past the gate: the Space does not exist, so this is a plain not-found, not a step-up demand.
    const party = await w.call(...a.party);
    expect(party.body?.code).not.toBe("MFA_REQUIRED");
  });

  it("does not ask someone who has no factor, as for API tokens", async () => {
    const w = await world(false);
    const res = await w.call(...actions().policy);
    expect(res.status).toBe(200);
  });
});
