import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PublicApi } from "@legallabs/contracts";
import { createGateway } from "@legallabs/model-gateway";
import { createMemoryStore } from "@legallabs/storage";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { createDrafts } from "../drafts/drafts.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { createVaults } from "../vaults/vaults.js";
import { renderSpec, SPEC_PATH } from "./openapi-cli.js";
import { createPublicApi, ipAllowed } from "./service.js";

const pool = testPool();
afterAll(() => pool.end());

function harness(ip = "203.0.113.9") {
  const store = createMemoryStore();
  const documents = testDocuments(pool, { store });
  const vaults = createVaults(pool, { documents, store });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: testThreads(pool, documents),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
    }),
    vaults,
    publicApi: createPublicApi(pool),
    clientIp: () => ip,
  });
  const signIn = async (m: Pick<Seeded, "slug" | "email">) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  // biome-ignore lint/suspicious/noExplicitAny: tests read many response shapes
  type Reply = { status: number; body: any; text: string; headers: Headers };
  const call = async (
    auth: { cookie?: string; token?: string },
    method: string,
    path: string,
    json?: unknown,
  ): Promise<Reply> => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: {
        ...(auth.cookie ? { cookie: auth.cookie } : {}),
        ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body, text, headers: res.headers };
  };
  return { app, call, signIn, vaults };
}

/** An admin signed in, with a service account ready to hold tokens. */
async function setup(ip?: string) {
  const h = harness(ip);
  const admin = await seedMember(pool);
  const cookie = await h.signIn(admin);
  const made = await h.call({ cookie }, "POST", "/admin/service-accounts", { name: "reporting" });
  expect(made.status).toBe(201);
  const accountId: string = made.body.id;
  const issue = async (
    scopes: string[],
    extra: { expires_in_days?: number; cidrs?: string[] } = {},
  ) => {
    const res = await h.call({ cookie }, "POST", `/admin/service-accounts/${accountId}/tokens`, {
      name: "ci",
      scopes,
      ...extra,
    });
    expect(res.status).toBe(201);
    return { token: res.body.token as string, id: res.body.token_id as string };
  };
  return { ...h, admin, cookie, accountId, issue };
}

describe("issuing tokens", () => {
  it("returns the secret once, stores only a hash, and audits it", async () => {
    const t = await setup();
    const tooLong = await t.call(
      { cookie: t.cookie },
      "POST",
      `/admin/service-accounts/${t.accountId}/tokens`,
      { name: "x", scopes: ["vaults:read"], expires_in_days: 400 },
    );
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.code).toBe("EXPIRY_MAX");

    const { token, id } = await t.issue(["vaults:read"], { expires_in_days: 365 });
    expect(token).toMatch(/^cns_[A-Za-z0-9]{40}$/);

    const stored = await pool.query<{ token_hash: Buffer; name: string }>(
      "select token_hash, name from core.api_token where id = $1",
      [id],
    );
    expect(stored.rows[0]?.token_hash.equals(createHash("sha256").update(token).digest())).toBe(
      true,
    );
    // Nothing else the row holds contains the secret.
    const row = await pool.query("select t::text as text from core.api_token t where id = $1", [
      id,
    ]);
    expect(row.rows[0].text).not.toContain(token.slice(4));

    const listed = await t.call({ cookie: t.cookie }, "GET", "/admin/service-accounts");
    expect(JSON.stringify(listed.body)).not.toContain(token.slice(4));
    expect(listed.body.service_accounts[0].tokens[0].id).toBe(id);

    const trail = await auditTrail(pool, t.admin.workspaceId);
    expect(trail.some((e) => e.action === "token.created" && e.object_id === id)).toBe(true);
  });

  it("refuses a plain member and a bad scope", async () => {
    const t = await setup();
    const member = await seedMember(pool, { permissions: [] });
    const cookie = await t.signIn(member);
    const res = await t.call({ cookie }, "GET", "/admin/service-accounts");
    expect(res.status).toBe(403);
    const bad = await t.call(
      { cookie: t.cookie },
      "POST",
      `/admin/service-accounts/${t.accountId}/tokens`,
      { name: "x", scopes: ["admin.everything"] },
    );
    expect(bad.status).toBe(400);
  });

  it("rejects a malformed network restriction", async () => {
    const t = await setup();
    const res = await t.call(
      { cookie: t.cookie },
      "POST",
      `/admin/service-accounts/${t.accountId}/tokens`,
      { name: "x", scopes: ["vaults:read"], cidrs: ["not-an-address"] },
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_CIDR");
  });
});

describe("scope enforcement", () => {
  it("lets a token reach only what its scopes name", async () => {
    const t = await setup();
    const { token } = await t.issue(["audit:read"]);

    const who = await t.call({ token }, "GET", "/whoami");
    expect(who.status).toBe(200);
    expect(who.body).toMatchObject({
      principal_id: t.accountId,
      kind: "service",
      workspace_id: t.admin.workspaceId,
      scopes: ["audit:read"],
    });

    const events = await t.call({ token }, "GET", "/audit/events?limit=1000");
    expect(events.status).toBe(200);
    expect(events.body.events.length).toBeGreaterThan(0);
    PublicApi.AuditEventsPage.parse(events.body);

    // The scope isn't there, so the route refuses it and the refusal is audited.
    for (const path of ["/vaults", "/history/queries", "/threads", "/admin/service-accounts"]) {
      const res = await t.call({ token }, "GET", path);
      expect(res.status, path).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN_SCOPE");
    }
    const create = await t.call({ token }, "POST", "/admin/service-accounts", { name: "sneaky" });
    expect(create.status).toBe(403);

    const trail = await auditTrail(pool, t.admin.workspaceId);
    const denials = trail.filter((e) => e.action === "token.used_denied");
    expect(denials.length).toBeGreaterThanOrEqual(5);
    expect(denials[0]?.details).toMatchObject({ reason: "vaults:read" });
  });

  it("keeps audit and history behind their own scopes at the database too", async () => {
    const t = await setup();
    const { token } = await t.issue(["vaults:read"]);
    const audit = await t.call({ token }, "GET", "/audit/events");
    expect(audit.status).toBe(403);

    // Even if a route were mounted by mistake, the row policy gives a token nothing it lacks a
    // scope for: query as the service account with no scopes set.
    const api = createPublicApi(pool);
    const none = await api.asCaller(
      {
        principal: { sessionId: "x", userId: t.accountId, workspaceId: t.admin.workspaceId },
        scopes: [],
      },
      async (db) => (await db.query("select count(*)::int n from admin.audit_event")).rows[0].n,
    );
    expect(none).toBe(0);
    const scoped = await api.asCaller(
      {
        principal: { sessionId: "x", userId: t.accountId, workspaceId: t.admin.workspaceId },
        scopes: ["audit:read"],
      },
      async (db) => (await db.query("select count(*)::int n from admin.audit_event")).rows[0].n,
    );
    expect(scoped).toBeGreaterThan(0);
  });

  it("does not let a token act as an admin", async () => {
    const t = await setup();
    const { token } = await t.issue(["audit:read", "history:read", "vaults:read"]);
    const res = await t.call({ token }, "POST", `/admin/service-accounts/${t.accountId}/tokens`, {
      name: "more",
      scopes: ["audit:read"],
    });
    expect(res.status).toBe(403);
  });
});

describe("revoked, expired and restricted tokens", () => {
  it("answers 401 after a revoke", async () => {
    const t = await setup();
    const { token, id } = await t.issue(["audit:read"]);
    expect((await t.call({ token }, "GET", "/whoami")).status).toBe(200);
    const revoke = await t.call(
      { cookie: t.cookie },
      "POST",
      `/admin/service-accounts/${t.accountId}/tokens/${id}/revoke`,
    );
    expect(revoke.status).toBe(204);
    const after = await t.call({ token }, "GET", "/whoami");
    expect(after.status).toBe(401);
    const trail = await auditTrail(pool, t.admin.workspaceId);
    expect(trail.some((e) => e.action === "token.revoked" && e.object_id === id)).toBe(true);
  });

  it("answers 401 once the expiry passes", async () => {
    const t = await setup();
    const { token, id } = await t.issue(["audit:read"]);
    await pool.query(
      "update core.api_token set expires_at = now() - interval '1 second', created_at = now() - interval '2 days' where id = $1",
      [id],
    );
    expect((await t.call({ token }, "GET", "/whoami")).status).toBe(401);
  });

  it("answers 401 for a token that was never issued, or a session cookie value used as one", async () => {
    const t = await setup();
    const fake = `cns_${"A".repeat(40)}`;
    expect((await t.call({ token: fake }, "GET", "/whoami")).status).toBe(401);
    expect((await t.call({}, "GET", "/whoami")).status).toBe(401);
  });

  it("stops a token when its service account is deleted", async () => {
    const t = await setup();
    const { token } = await t.issue(["audit:read"]);
    const gone = await t.call(
      { cookie: t.cookie },
      "DELETE",
      `/admin/service-accounts/${t.accountId}`,
    );
    expect(gone.status).toBe(204);
    expect((await t.call({ token }, "GET", "/whoami")).status).toBe(401);
  });

  it("refuses an address outside the allowed networks", async () => {
    const t = await setup("203.0.113.9");
    const { token } = await t.issue(["audit:read"], { cidrs: ["10.0.0.0/8"] });
    const res = await t.call({ token }, "GET", "/whoami");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("IP_NOT_ALLOWED");
    const inside = await setup("10.1.2.3");
    const ok = await inside.issue(["audit:read"], { cidrs: ["10.0.0.0/8", "2001:db8::/32"] });
    expect((await inside.call({ token: ok.token }, "GET", "/whoami")).status).toBe(200);
  });

  it("matches networks correctly", () => {
    expect(ipAllowed("10.2.3.4", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("11.2.3.4", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("::ffff:10.2.3.4", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipAllowed(null, ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed(null, [])).toBe(true);
  });

  it("rotates with a 24 hour overlap", async () => {
    const t = await setup();
    const old = await t.issue(["audit:read"], { expires_in_days: 90 });
    const rotated = await t.call(
      { cookie: t.cookie },
      "POST",
      `/admin/service-accounts/${t.accountId}/tokens/${old.id}/rotate`,
    );
    expect(rotated.status).toBe(201);
    const next = rotated.body.token as string;
    expect(next).not.toBe(old.token);
    // Both work now, so a deployment can cut over.
    expect((await t.call({ token: old.token }, "GET", "/whoami")).status).toBe(200);
    expect((await t.call({ token: next }, "GET", "/whoami")).status).toBe(200);
    const { rows } = await pool.query<{ hours: number }>(
      "select extract(epoch from (expires_at - now())) / 3600 as hours from core.api_token where id = $1",
      [old.id],
    );
    expect(Number(rows[0]?.hours)).toBeLessThanOrEqual(24);
    // After the overlap the old one stops.
    await pool.query(
      "update core.api_token set expires_at = now() - interval '1 second', created_at = now() - interval '2 days' where id = $1",
      [old.id],
    );
    expect((await t.call({ token: old.token }, "GET", "/whoami")).status).toBe(401);
    expect((await t.call({ token: next }, "GET", "/whoami")).status).toBe(200);
  });

  it("limits each token to 600 requests a minute", async () => {
    const t = await setup();
    const { token } = await t.issue(["audit:read"]);
    let limited = 0;
    for (let i = 0; i < 605; i += 1) {
      const res = await t.call({ token }, "GET", "/whoami");
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBe(5);
  }, 60_000);
});

describe("audit events", () => {
  it("filters, pages and exports", async () => {
    const t = await setup();
    const { token } = await t.issue(["audit:read"]);
    const first = await t.call({ token }, "GET", "/audit/events?limit=2");
    expect(first.body.events).toHaveLength(2);
    expect(first.body.next_cursor).toBeTruthy();
    const second = await t.call(
      { token },
      "GET",
      `/audit/events?limit=2&cursor=${first.body.next_cursor}`,
    );
    expect(second.body.events[0].seq).toBeLessThan(first.body.events[1].seq);

    const created = await t.call(
      { token },
      "GET",
      "/audit/events?filter[action]=token.created&filter[object_type]=api_token",
    );
    expect(created.body.events.length).toBeGreaterThan(0);
    expect(created.body.events.every((e: { action: string }) => e.action === "token.created")).toBe(
      true,
    );

    const csv = await t.call({ token }, "GET", "/audit/events/export.csv");
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.text.split("\r\n")[0]).toBe(
      "seq,at,actor_type,actor_id,action,object_type,object_id,details,ip",
    );
    expect(csv.text).toContain("token.created");
  });

  it("refuses a range over seven days and bad parameters", async () => {
    const t = await setup();
    const { token } = await t.issue(["audit:read"]);
    const wide = await t.call(
      { token },
      "GET",
      "/audit/events?from=2020-01-01T00:00:00Z&to=2020-01-20T00:00:00Z",
    );
    expect(wide.status).toBe(422);
    expect(wide.body.code).toBe("RANGE_TOO_LARGE");
    expect((await t.call({ token }, "GET", "/audit/events?limit=5000")).status).toBe(400);
    expect((await t.call({ token }, "GET", "/audit/events?cursor=abc")).status).toBe(400);
    expect((await t.call({ token }, "GET", "/audit/events?from=yesterday")).status).toBe(400);
  });

  it("never shows another workspace's events", async () => {
    const a = await setup();
    const b = await setup();
    const { token } = await a.issue(["audit:read"]);
    const events = await a.call({ token }, "GET", "/audit/events?limit=1000");
    const mine = await auditTrail(pool, a.admin.workspaceId);
    expect(events.body.events).toHaveLength(mine.length);
    const theirs = await auditTrail(pool, b.admin.workspaceId);
    expect(theirs.length).toBeGreaterThan(0);
  });
});

describe("query history", () => {
  it("lists queries, ids and counts only, with a cursor", async () => {
    const t = await setup();
    const { token } = await t.issue(["history:read"]);
    for (const [action, cls] of [
      ["thread.ask", "query"],
      ["thread.ask", "query"],
      ["document.open", "other"],
    ] as const) {
      await pool.query(
        `insert into analytics.usage_event (workspace_id, user_id, access_point, surface, action, action_class)
         values ($1, $2, 'web', 'web', $3, $4)`,
        [t.admin.workspaceId, t.admin.userId, action, cls],
      );
    }
    const page = await t.call({ token }, "GET", "/history/queries?limit=1");
    expect(page.status).toBe(200);
    expect(page.body.queries).toHaveLength(1);
    expect(page.body.next_cursor).toBeTruthy();
    const rest = await t.call({ token }, "GET", `/history/queries?cursor=${page.body.next_cursor}`);
    expect(rest.body.queries).toHaveLength(1);
    expect(rest.body.next_cursor).toBeNull();
    PublicApi.QueryHistoryPage.parse(rest.body);
    expect(JSON.stringify(page.body)).not.toMatch(/prompt|content|text/);
  });
});

describe("vaults", () => {
  it("shows a service account only the vaults shared with it", async () => {
    const t = await setup();
    const { token } = await t.issue(["vaults:read"]);
    const shared = await t.vaults.create(
      { sessionId: "s", userId: t.admin.userId, workspaceId: t.admin.workspaceId },
      { name: "Shared with the bot" },
      { ip: null, userAgent: null },
    );
    const hidden = await t.vaults.create(
      { sessionId: "s", userId: t.admin.userId, workspaceId: t.admin.workspaceId },
      { name: "Private" },
      { ip: null, userAgent: null },
    );
    if (!shared.ok || !hidden.ok) throw new Error("setup failed");
    await pool.query(
      `insert into core.share_grant (workspace_id, object_type, object_id, principal_type, principal_id, level, granted_by)
       values ($1, 'vault', $2, 'user', $3, 'view', $4)`,
      [t.admin.workspaceId, shared.value.id, t.accountId, t.admin.userId],
    );

    const list = await t.call({ token }, "GET", "/vaults");
    expect(list.status).toBe(200);
    PublicApi.VaultList.parse(list.body);
    expect(list.body.vaults.map((v: { name: string }) => v.name)).toEqual(["Shared with the bot"]);

    const one = await t.call({ token }, "GET", `/vaults/${shared.value.id}`);
    expect(one.status).toBe(200);
    // The same answer for "not shared" and "doesn't exist".
    expect((await t.call({ token }, "GET", `/vaults/${hidden.value.id}`)).status).toBe(404);
    expect((await t.call({ token }, "GET", `/vaults/${randomUUID()}`)).status).toBe(404);

    const tree = await t.call({ token }, "GET", `/vaults/${shared.value.id}/tree`);
    expect(tree.status).toBe(200);
    PublicApi.VaultTree.parse(tree.body);
    expect((await t.call({ token }, "GET", `/vaults/${hidden.value.id}/tree`)).status).toBe(404);

    // The vault routes for people are untouched: a signed-in admin still gets the full shape.
    const asAdmin = await t.call({ cookie: t.cookie }, "GET", "/vaults");
    expect(asAdmin.body.vaults[0]).toHaveProperty("my_access");
  });

  it("refuses writes with a token", async () => {
    const t = await setup();
    const { token } = await t.issue(["vaults:read"]);
    expect((await t.call({ token }, "POST", "/vaults", { name: "nope" })).status).toBe(403);
  });
});

describe("the published spec", () => {
  it("is served without signing in and matches the committed file", async () => {
    const t = harness();
    const res = await t.call({}, "GET", "/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    // A drift here means the code changed and docs/api/openapi.json was not regenerated:
    // run `pnpm --filter @legallabs/api openapi:write`.
    expect(readFileSync(SPEC_PATH, "utf8")).toBe(renderSpec());
  });

  it("describes every operation once, with resolvable references", () => {
    const doc = PublicApi.buildOpenApi();
    const ids = Object.values(doc.paths).flatMap((p) =>
      Object.values(p as Record<string, { operationId: string }>).map((o) => o.operationId),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(PublicApi.operations.map((o) => o.id).sort());
    const text = JSON.stringify(doc);
    for (const [, ref] of text.matchAll(/"\$ref":"([^"]+)"/g)) {
      expect(ref?.startsWith("#/")).toBe(true);
    }
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(
        ops as Record<string, { parameters?: { name: string; in: string }[] }>,
      )) {
        const named = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        const declared = (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name);
        expect(declared.sort(), `${method} ${path}`).toEqual(named.sort());
      }
    }
    expect(Object.keys(doc.paths)).toContain("/audit/events");
  });

  it("matches the routes: every token operation is mounted and answers", async () => {
    const t = await setup();
    const { token } = await t.issue(["audit:read", "history:read", "vaults:read"]);
    for (const op of PublicApi.operations.filter((o) => o.scope !== "session")) {
      const path = op.path.replace("{id}", randomUUID());
      const res = await t.call({ token }, op.method.toUpperCase(), path);
      expect([200, 404], `${op.id} -> ${res.status}`).toContain(res.status);
      if (op.id !== "getVault" && op.id !== "listVaultTree") expect(res.status).toBe(200);
    }
  });
});
