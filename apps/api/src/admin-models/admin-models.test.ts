import { randomBytes, randomUUID } from "node:crypto";
import type { ModelConfig, ModelPolicy } from "@legallabs/contracts";
import { createGateway } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
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
import { checkChoice, pickModel } from "./allowlist.js";
import { createAdminConnectors } from "./connectors.js";
import {
  type McpDiscovery,
  manifestHash,
  type RawTool,
  safeConnectorUrl,
  toolHash,
} from "./discovery.js";
import { createAdminModels } from "./models.js";
import { createSecretBox, scrub } from "./secrets.js";

const pool = testPool();
afterAll(() => pool.end());

const secrets = createSecretBox(randomBytes(32).toString("base64"));
const KEY = "sk-live-SUPERSECRETKEY123456";

// A tool is a read only when the server says so; the default has to be the cautious one.
const tool = (name: string, extra: Partial<RawTool> = {}): RawTool => ({
  name,
  description: `${name} tool`,
  input_schema: { type: "object" },
  annotations: { readOnlyHint: true },
  ...extra,
});

function harness() {
  let manifest: RawTool[] = [
    tool("search"),
    tool("read"),
    tool("send_mail", { annotations: { destructiveHint: true } }),
    tool("list"),
  ];
  const discovery: McpDiscovery = async () => manifest;
  const tested: { key: string | null }[] = [];
  const models = createAdminModels(pool, {
    secrets,
    tester: async (_e, key) => {
      tested.push({ key });
      return { ok: true, message: "The endpoint answered." };
    },
  });
  const connectors = createAdminConnectors(pool, { secrets, discovery });
  const documents = testDocuments(pool);
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: testThreads(pool, documents, {}),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
    }),
    adminModels: { models, connectors },
    clientIp: () => "203.0.113.9",
  });
  const signIn = async (m: Pick<Seeded, "slug" | "email">) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const call = async (cookie: string, method: string, path: string, json?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: tests read many response shapes
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body, text };
  };
  return {
    call,
    signIn,
    models,
    connectors,
    setManifest: (m: RawTool[]) => {
      manifest = m;
    },
    tested,
  };
}

/** An admin, plus a plain member of the same workspace in a role with no admin rights. */
async function people() {
  const admin = await seedMember(pool);
  const roleId = (
    await pool.query<{ id: string }>(
      "insert into core.role (workspace_id, name, permissions) values ($1, 'Lawyer', $2) returning id",
      [admin.workspaceId, ["threads.use"]],
    )
  ).rows[0]?.id as string;
  const email = `lee@${admin.slug}.test`;
  const userId = (
    await pool.query<{ id: string }>(
      `insert into core."user" (workspace_id, email, role_id, status) values ($1, $2, $3, 'active') returning id`,
      [admin.workspaceId, email, roleId],
    )
  ).rows[0]?.id as string;
  await pool.query(
    "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
    [admin.workspaceId, userId, await hashPassword(PASSWORD)],
  );
  return {
    admin,
    lee: { slug: admin.slug, email, workspaceId: admin.workspaceId, userId },
    roleId,
  };
}

describe("secrets", () => {
  it("seals and opens, and a wrong key or tampering fails", () => {
    const sealed = secrets.seal(KEY);
    expect(sealed.includes(Buffer.from(KEY))).toBe(false);
    expect(secrets.open(sealed)).toBe(KEY);
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 1;
    expect(() => secrets.open(sealed)).toThrow();
    const other = createSecretBox(randomBytes(32).toString("base64"));
    expect(() => other.open(secrets.seal(KEY))).toThrow();
  });
  it("scrubs known values and key shapes", () => {
    expect(
      scrub(`failed with ${KEY} and sk-abcdefghij12 and Bearer abcdefgh12345`, [KEY]),
    ).not.toMatch(/sk-|Bearer abc|SUPERSECRET/);
  });
});

describe("allow-list rules", () => {
  const role = randomUUID();
  const me = { userId: randomUUID(), roleId: role };
  const open: ModelPolicy = { zdr_only: false, region_only: null, selector_disabled_roles: [] };
  const base: ModelConfig = {
    provider: "anthropic",
    model: "m",
    enabled: true,
    enabled_for_roles: [role],
    enabled_for_users: [],
    byok_secret_ref: null,
    endpoint_url: null,
    region: "au",
    zdr: true,
    capabilities: ["chat"],
    context_window: 1000,
    task_class_default: ["plan"],
  };
  it("needs enabled and a listed role or user", () => {
    expect(pickModel([base], me, open, "plan").ok).toBe(true);
    expect(pickModel([{ ...base, enabled: false }], me, open, "plan")).toEqual({
      ok: false,
      reason: "NO_ALLOWED_MODEL",
    });
    expect(pickModel([{ ...base, enabled_for_roles: [] }], me, open, "plan").ok).toBe(false);
    expect(
      pickModel(
        [{ ...base, enabled_for_roles: [], enabled_for_users: [me.userId] }],
        me,
        open,
        "plan",
      ).ok,
    ).toBe(true);
  });
  it("applies ZDR-only and region policy, and matter limits", () => {
    const noZdr = { ...base, zdr: false };
    expect(pickModel([noZdr], me, { ...open, zdr_only: true }, "plan")).toEqual({
      ok: false,
      reason: "NO_ALLOWED_MODEL",
    });
    expect(pickModel([base], me, { ...open, region_only: "eu" }, "plan").ok).toBe(false);
    expect(pickModel([base], me, open, "plan", { allowedModels: ["other/x"] }).ok).toBe(false);
  });
  it("refuses a chosen model that isn't allowed", () => {
    expect(checkChoice([{ ...base, enabled_for_roles: [] }], me, open, base)).toEqual({
      ok: false,
      reason: "MODEL_NOT_ALLOWED",
    });
  });
});

describe("models admin (ADM-005)", () => {
  it("is admin only", async () => {
    const h = harness();
    const { lee } = await people();
    const cookie = await h.signIn(lee);
    expect((await h.call(cookie, "GET", "/admin/models")).status).toBe(403);
    expect(
      (
        await h.call(cookie, "PUT", "/admin/model-policy", {
          zdr_only: true,
          region_only: null,
          selector_disabled_roles: [],
        })
      ).status,
    ).toBe(403);
  });

  it("ADM-005-a: a model enabled for admins only is absent for a member and refused for them", async () => {
    const h = harness();
    const { admin, lee, roleId } = await people();
    const a = await h.signIn(admin);
    const l = await h.signIn(lee);
    const adminRole = (
      await pool.query<{ id: string }>(
        "select id from core.role where workspace_id = $1 and name = 'Admin'",
        [admin.workspaceId],
      )
    ).rows[0]?.id as string;
    const set = await h.call(a, "PATCH", "/admin/models/anthropic/claude-haiku-5-5", {
      enabled: true,
      enabled_for_roles: [adminRole],
    });
    expect(set.status).toBe(200);
    expect((await h.call(l, "GET", "/models/allowed")).body.items).toEqual([]);
    expect(
      (await h.call(a, "GET", "/models/allowed")).body.items.map((m: ModelConfig) => m.model),
    ).toEqual(["claude-haiku-5-5"]);
    expect(
      await h.models.checkChoice(lee as never, {
        provider: "anthropic",
        model: "claude-haiku-5-5",
      }),
    ).toEqual({ ok: false, reason: "MODEL_NOT_ALLOWED" });
    // Giving the Lawyer role access makes it appear.
    await h.call(a, "PATCH", "/admin/models/anthropic/claude-haiku-5-5", {
      enabled_for_roles: [adminRole, roleId],
    });
    expect((await h.call(l, "GET", "/models/allowed")).body.items).toHaveLength(1);
    // Turning the selector off for the role empties the list (Auto is forced).
    await h.call(a, "PUT", "/admin/model-policy", {
      zdr_only: false,
      region_only: null,
      selector_disabled_roles: [roleId],
    });
    expect((await h.call(l, "GET", "/models/allowed")).body).toMatchObject({
      items: [],
      selector: false,
    });
  });

  it("ADM-005-b: zdr_only leaves only ZDR models as candidates", async () => {
    const h = harness();
    const { admin } = await people();
    const a = await h.signIn(admin);
    const list = await h.call(a, "GET", "/admin/models");
    expect(list.status).toBe(200);
    const google = list.body.items.find((m: ModelConfig) => m.provider === "google");
    expect(google.zdr).toBe(false);
    const adminRole = (
      await pool.query<{ id: string }>("select id from core.role where workspace_id = $1", [
        admin.workspaceId,
      ])
    ).rows[0]?.id as string;
    await h.call(a, "PATCH", `/admin/models/google/${google.model}`, {
      enabled: true,
      enabled_for_roles: [adminRole],
    });
    expect((await h.call(a, "GET", "/models/allowed")).body.items).toHaveLength(1);
    await h.call(a, "PUT", "/admin/model-policy", {
      zdr_only: true,
      region_only: null,
      selector_disabled_roles: [],
    });
    expect((await h.call(a, "GET", "/models/allowed")).body.items).toEqual([]);
  });

  it("ADM-005-c: a key is stored sealed, the reference is returned, the key never is", async () => {
    const h = harness();
    const { admin } = await people();
    const a = await h.signIn(admin);
    const saved = await h.call(a, "PUT", "/admin/models/anthropic/claude-haiku-5-5/key", {
      key: KEY,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.byok_secret_ref).toMatch(/^sec_[0-9a-f]{32}$/);
    const all = [
      saved.text,
      (await h.call(a, "GET", "/admin/models")).text,
      JSON.stringify(await auditTrail(pool, admin.workspaceId)),
    ];
    for (const t of all) expect(t).not.toContain(KEY);
    const stored = await pool.query<{ ciphertext: Buffer }>(
      "select ciphertext from admin.secret where workspace_id = $1",
      [admin.workspaceId],
    );
    expect(stored.rows[0]?.ciphertext.includes(Buffer.from(KEY))).toBe(false);
    // The gateway reads it back at call time; replacing deletes the old one.
    expect(await h.models.keyFor(admin.workspaceId, saved.body.byok_secret_ref)).toBe(KEY);
    const again = await h.call(a, "PUT", "/admin/models/anthropic/claude-haiku-5-5/key", {
      key: `${KEY}-2`,
    });
    expect(
      (await pool.query("select 1 from admin.secret where workspace_id = $1", [admin.workspaceId]))
        .rowCount,
    ).toBe(1);
    expect(await h.models.keyFor(admin.workspaceId, saved.body.byok_secret_ref)).toBeNull();
    await h.call(a, "DELETE", "/admin/models/anthropic/claude-haiku-5-5/key");
    expect(
      (await pool.query("select 1 from admin.secret where workspace_id = $1", [admin.workspaceId]))
        .rowCount,
    ).toBe(0);
    expect(again.status).toBe(200);
  });

  it("the app role can't read sealed bytes directly", async () => {
    const h = harness();
    const { admin } = await people();
    const a = await h.signIn(admin);
    await h.call(a, "PUT", "/admin/models/anthropic/claude-haiku-5-5/key", { key: KEY });
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role legallabs_app");
      await c.query(
        "select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
        [admin.userId, admin.workspaceId],
      );
      await expect(c.query("select ciphertext from admin.secret")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("adds a local endpoint as region local and ZDR, and tests it with its key", async () => {
    const h = harness();
    const { admin } = await people();
    const a = await h.signIn(admin);
    const made = await h.call(a, "POST", "/admin/models/local", {
      name: "vllm-1",
      url: "http://vllm.internal:8000/v1",
      api_key: "local-key-123",
      context_window: 32000,
      capabilities: ["chat"],
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      provider: "local",
      region: "local",
      zdr: true,
      enabled: false,
    });
    expect(made.text).not.toContain("local-key-123");
    expect((await h.call(a, "POST", "/admin/models/local/vllm-1/test")).body).toEqual({
      ok: true,
      message: "The endpoint answered.",
    });
    expect(h.tested[0]?.key).toBe("local-key-123");
    // region local needs zdr: the database refuses the combination otherwise.
    expect((await h.call(a, "PATCH", "/admin/models/local/vllm-1", { zdr: false })).status).toBe(
      422,
    );
  });

  it("rejects an unknown model and records audit events", async () => {
    const h = harness();
    const { admin } = await people();
    const a = await h.signIn(admin);
    expect(
      (await h.call(a, "PATCH", "/admin/models/nobody/nothing", { enabled: true })).status,
    ).toBe(404);
    await h.call(a, "PATCH", "/admin/models/anthropic/claude-haiku-5-5", { enabled: true });
    expect(
      (await auditTrail(pool, admin.workspaceId)).map((r: { action: string }) => r.action),
    ).toContain("models.config_changed");
  });
});

describe("connectors admin (ADM-006, CON-001)", () => {
  const register = (h: ReturnType<typeof harness>, cookie: string) =>
    h.call(cookie, "POST", "/admin/connectors", {
      name: "Docs",
      url: "https://mcp.example.com/mcp",
      auth: { kind: "bearer", token: "tok-abcdefgh" },
    });

  it("ADM-006-a: discovery blocks every tool, approval needs a non-blocked tool", async () => {
    const h = harness();
    const { admin } = await people();
    const a = await h.signIn(admin);
    const made = await register(h, a);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      status: "pending_approval",
      trust_tier: "custom",
      badge: "Custom — not reviewed",
    });
    expect(made.text).not.toContain("tok-abcdefgh");
    const id = made.body.id;
    expect((await h.call(a, "POST", `/admin/connectors/${id}/approve`)).body.code).toBe(
      "NO_TOOLS_DISCOVERED",
    );
    const found = await h.call(a, "POST", `/admin/connectors/${id}/discover`);
    expect(found.body.connector.tools).toHaveLength(4);
    expect(found.body.connector.tools.every((t: { policy: string }) => t.policy === "block")).toBe(
      true,
    );
    expect((await h.call(a, "POST", `/admin/connectors/${id}/approve`)).body.code).toBe(
      "NO_TOOL_ALLOWED",
    );
    await h.call(a, "PUT", `/admin/connectors/${id}/tools/search/policy`, { policy: "allow" });
    await h.call(a, "PUT", `/admin/connectors/${id}/tools/read/policy`, { policy: "allow" });
    const ok = await h.call(a, "POST", `/admin/connectors/${id}/approve`);
    expect(ok.body.status).toBe("enabled");
  });

  it("rejects non-public or non-https URLs", async () => {
    const h = harness();
    const { admin } = await people();
    const a = await h.signIn(admin);
    for (const url of [
      "https://127.0.0.1/mcp",
      "https://localhost/mcp",
      "https://10.0.0.5/x",
      "https://svc.internal/x",
    ]) {
      const r = await h.call(a, "POST", "/admin/connectors", {
        name: "x",
        url,
        auth: { kind: "none" },
      });
      expect(r.status).toBe(422);
    }
    expect(
      (
        await h.call(a, "POST", "/admin/connectors", {
          name: "x",
          url: "http://example.com/x",
          auth: { kind: "none" },
        })
      ).status,
    ).toBe(400);
    expect(safeConnectorUrl("https://mcp.example.com/mcp")).toBe(true);
  });

  it("ADM-006-b: a user can tighten but not loosen", async () => {
    const h = harness();
    const { admin, lee } = await people();
    const a = await h.signIn(admin);
    const l = await h.signIn(lee);
    const id = (await register(h, a)).body.id;
    await h.call(a, "POST", `/admin/connectors/${id}/discover`);
    await h.call(a, "PUT", `/admin/connectors/${id}/tools/search/policy`, { policy: "ask_user" });
    await h.call(a, "POST", `/admin/connectors/${id}/approve`);
    expect(
      (await h.call(l, "PUT", `/connectors/${id}/tools/search/my-policy`, { policy: "allow" }))
        .status,
    ).toBe(400);
    const tight = await h.call(l, "PUT", `/connectors/${id}/tools/search/my-policy`, {
      policy: "block",
    });
    expect(tight.status).toBe(200);
    expect(tight.body.tools.find((t: { name: string }) => t.name === "search").user_policy).toBe(
      "block",
    );
    // Looser than the workspace's `block` tool is refused as 422.
    const loose = await h.call(l, "PUT", `/connectors/${id}/tools/read/my-policy`, {
      policy: "ask_user",
    });
    expect(loose.status).toBe(422);
    expect(loose.body.code).toBe("POLICY_TIGHTEN_ONLY");
    // Members never see the admin list's unapproved connectors, and cannot administer.
    expect((await h.call(l, "POST", `/admin/connectors/${id}/disable`)).status).toBe(403);
  });

  it("ADM-006-c: drift disables the connector, blocks calls, and approval re-pins with new tools blocked", async () => {
    const h = harness();
    const { admin } = await people();
    const a = await h.signIn(admin);
    const id = (await register(h, a)).body.id;
    const first = await h.call(a, "POST", `/admin/connectors/${id}/discover`);
    await h.call(a, "PUT", `/admin/connectors/${id}/tools/search/policy`, { policy: "allow" });
    await h.call(a, "POST", `/admin/connectors/${id}/approve`);
    const pin = first.body.connector.manifest_hash;
    const call = (hash: string | undefined) =>
      h.connectors.decide(
        admin as never,
        {
          connectorId: id,
          toolName: "search",
          surface: "interactive",
          callsToToolInRun: 0,
          observedManifestHash: hash,
        },
        { ip: null, userAgent: null },
      );
    expect((await call(pin)).decision).toBe("allow");

    h.setManifest([
      tool("search", { description: "changed!" }),
      tool("read"),
      tool("send_mail", { annotations: { destructiveHint: true } }),
      tool("list"),
    ]);
    const drift = await h.call(a, "POST", `/admin/connectors/${id}/discover`);
    expect(drift.body.diff).toEqual({ added: [], removed: [], changed: ["search"] });
    expect(drift.body.connector).toMatchObject({
      status: "disabled",
      disabled_reason: "CONNECTOR_MANIFEST_CHANGED",
      manifest_hash: pin,
    });
    expect((await call(pin)).decision).toBe("block");
    expect(
      (await auditTrail(pool, admin.workspaceId)).map((r: { action: string }) => r.action),
    ).toContain("connector.schema_drift");

    // Re-approval needs an allowed tool: the changed one came back blocked.
    expect((await h.call(a, "POST", `/admin/connectors/${id}/approve`)).body.code).toBe(
      "NO_TOOL_ALLOWED",
    );
    await h.call(a, "PUT", `/admin/connectors/${id}/tools/search/policy`, { policy: "allow" });
    const re = await h.call(a, "POST", `/admin/connectors/${id}/approve`);
    expect(re.body.status).toBe("enabled");
    expect(re.body.manifest_hash).not.toBe(pin);
  });

  it("CON-001: decide covers destructive hints, scheduled runs, call limits and unknown tools", async () => {
    const h = harness();
    const { admin } = await people();
    const a = await h.signIn(admin);
    const made = (await register(h, a)).body;
    const found = await h.call(a, "POST", `/admin/connectors/${made.id}/discover`);
    for (const t of ["search", "send_mail"])
      await h.call(a, "PUT", `/admin/connectors/${made.id}/tools/${t}/policy`, { policy: "allow" });
    await h.call(a, "POST", `/admin/connectors/${made.id}/approve`);
    const pin = found.body.connector.manifest_hash;
    const d = (toolName: string, over: object = {}) =>
      h.connectors.decide(
        admin as never,
        {
          connectorId: made.id,
          toolName,
          surface: "interactive",
          callsToToolInRun: 0,
          observedManifestHash: pin,
          ...over,
        },
        { ip: null, userAgent: null },
      );
    expect((await d("search")).decision).toBe("allow");
    expect((await d("send_mail")).decision).toBe("ask_user");
    expect((await d("send_mail", { surface: "scheduled" })).decision).toBe("block");
    expect((await d("search", { callsToToolInRun: 20 })).decision).toBe("ask_user");
    expect((await d("nope")).decision).toBe("block");
    expect((await d("read")).decision).toBe("block");
    // A server presenting no hash, or a different one, is treated as drift.
    expect((await d("search", { observedManifestHash: undefined })).decision).toBe("block");
    expect((await d("search", { observedManifestHash: "0".repeat(64) })).decision).toBe("block");
    expect((await d("search", { matterBlocksConnector: true })).decision).toBe("block");
  });

  // Pen-test P-06 (SEC-037, SEC-039): a workspace "allow" must not let a write run unattended or
  // without a click, and a server that leaves the annotations out is not vouching for its tools.
  it("P-06: writes and unannotated tools are never allowed without approval", async () => {
    const h = harness();
    h.setManifest([
      tool("search"),
      tool("create_note", { annotations: { readOnlyHint: false, destructiveHint: false } }),
      tool("mystery", { annotations: {} }),
      tool("liar", { annotations: { readOnlyHint: false } }),
    ]);
    const { admin } = await people();
    const a = await h.signIn(admin);
    const made = (await register(h, a)).body;
    const found = await h.call(a, "POST", `/admin/connectors/${made.id}/discover`);
    for (const t of ["search", "create_note", "mystery", "liar"])
      await h.call(a, "PUT", `/admin/connectors/${made.id}/tools/${t}/policy`, { policy: "allow" });
    await h.call(a, "POST", `/admin/connectors/${made.id}/approve`);
    const pin = found.body.connector.manifest_hash;
    const d = (toolName: string, surface: "interactive" | "scheduled") =>
      h.connectors.decide(
        admin as never,
        {
          connectorId: made.id,
          toolName,
          surface,
          callsToToolInRun: 0,
          observedManifestHash: pin,
        },
        { ip: null, userAgent: null },
      );
    expect((await d("search", "interactive")).decision).toBe("allow");
    expect((await d("search", "scheduled")).decision).toBe("allow");
    for (const writer of ["create_note", "mystery", "liar"]) {
      expect((await d(writer, "interactive")).decision, writer).toBe("ask_user");
      expect((await d(writer, "scheduled")).decision, writer).toBe("block");
    }
  });

  it("CON-001-c: fails closed, and audits, when the policy can't be read", async () => {
    const h = harness();
    const { admin } = await people();
    const brokenPool = { connect: () => Promise.reject(new Error("db down")) } as never;
    const broken = createAdminConnectors(brokenPool, { secrets, discovery: async () => [] });
    const r = await broken.decide(
      admin as never,
      {
        connectorId: randomUUID(),
        toolName: "search",
        surface: "interactive",
        callsToToolInRun: 0,
        observedManifestHash: "x",
      },
      { ip: null, userAgent: null },
    );
    expect(r).toMatchObject({ decision: "block", code: "POLICY_FAIL_CLOSED" });
    // A connector id that doesn't exist is also a block, never an error.
    const missing = await h.connectors.decide(
      admin as never,
      {
        connectorId: randomUUID(),
        toolName: "search",
        surface: "interactive",
        callsToToolInRun: 0,
        observedManifestHash: "x",
      },
      { ip: null, userAgent: null },
    );
    expect(missing.decision).toBe("block");
  });

  it("hashes tools stably regardless of key order", () => {
    const a = tool("t", { input_schema: { a: 1, b: { c: 2, d: 3 } } });
    const b = tool("t", { input_schema: { b: { d: 3, c: 2 }, a: 1 } });
    expect(toolHash(a)).toBe(toolHash(b));
    expect(manifestHash([toolHash(a), "x"])).toBe(manifestHash(["x", toolHash(a)]));
  });
});
