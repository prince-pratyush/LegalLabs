import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type GatewayCall, GatewayError } from "@legallabs/model-gateway";
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createLanguage } from "../addins/language.js";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { createDrafts } from "../drafts/drafts.js";
import { classify } from "../intake/classify.js";
import { seedMember, testDocuments, testPool, testThreads } from "../test-db.js";
import { countingProviders } from "../test-model-policy.js";
import { createWorkspaceGateway } from "./gateway.js";

const pool = testPool();
afterAll(() => pool.end());

const HAIKU = "anthropic/claude-haiku-5-5";
const QWEN = "ollama/qwen3:4b-instruct";

type Row = {
  enabled?: boolean;
  roles?: string[];
  users?: string[];
  zdr?: boolean;
  region?: string;
};

async function setup() {
  const member = await seedMember(pool);
  const { workspaceId, userId } = member;
  const roleId = (
    await pool.query<{ role_id: string }>('select role_id from core."user" where id = $1', [userId])
  ).rows[0]?.role_id as string;
  const counting = countingProviders(() => "[]");
  const gateway = createWorkspaceGateway(pool, {
    providers: counting.providers,
    recordUsage: async () => {},
  });
  const request = (user: string | null = userId): GatewayCall => ({
    task_class: "synthesize",
    messages: [{ role: "user", content: "hi" }],
    budget: { max_output: 10, max_cost_usd: 1 },
    routing: { workspace: workspaceId, user },
    trace: "t",
  });
  const model = (id: string, row: Row = {}) => {
    const [provider, ...name] = id.split("/");
    return pool.query(
      `insert into admin.model_config
         (workspace_id, provider, model, enabled, enabled_for_roles, enabled_for_users, zdr, region)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        workspaceId,
        provider,
        name.join("/"),
        row.enabled ?? true,
        row.roles ?? [roleId],
        row.users ?? [],
        row.zdr ?? false,
        row.region ?? "unspecified",
      ],
    );
  };
  const policy = (zdrOnly: boolean, region: string | null = null) =>
    pool.query(
      "insert into admin.model_policy (workspace_id, zdr_only, region_only) values ($1, $2, $3)",
      [workspaceId, zdrOnly, region],
    );
  const listed = async (user: string | null = userId) =>
    (await gateway.allowedModels("synthesize", { workspace: workspaceId, user })).map((m) => m.id);
  return { ...member, roleId, gateway, calls: counting.calls, request, model, policy, listed };
}

const ALL = [HAIKU, QWEN, "ollama/llama3.2:3b"];

describe("the workspace's model settings at the gateway", () => {
  it("leave the install's models usable until an admin configures one", async () => {
    const s = await setup();
    expect(await s.listed()).toEqual(ALL);
    expect((await s.gateway.call(s.request())).model).toBe(HAIKU);
  });

  it("zdr_only keeps content from a model no admin has declared zero retention", async () => {
    const s = await setup();
    await s.policy(true);
    const result = await s.gateway.call(s.request());
    expect(result.model).toBe(QWEN);
    expect(s.calls.anthropic).toBe(0);
  });

  it("zdr_only allows a model declared zero retention", async () => {
    const s = await setup();
    await s.policy(true);
    await s.model(HAIKU, { zdr: true });
    expect(await s.listed()).toEqual([HAIKU]);
  });

  it("once a model is configured, only enabled ones listed for the person are used", async () => {
    const s = await setup();
    await s.model(HAIKU);
    await s.model(QWEN, { enabled: false });
    expect(await s.listed()).toEqual([HAIKU]);
    expect(await s.listed(randomUUID())).toEqual([]);
    await expect(s.gateway.call(s.request(randomUUID()))).rejects.toMatchObject({
      code: "NO_ALLOWED_MODEL",
    });
    await expect(s.gateway.call({ ...s.request(), model: QWEN })).rejects.toMatchObject({
      code: "MODEL_NOT_ALLOWED",
    });
    expect(s.calls).toEqual({ anthropic: 0, ollama: 0 });
  });

  it("lists a person by name as well as by role", async () => {
    const s = await setup();
    await s.model(HAIKU, { roles: [], users: [s.userId] });
    expect(await s.listed()).toEqual([HAIKU]);
  });

  it("with nobody behind a call, uses a model that is listed for someone", async () => {
    const s = await setup();
    await s.model(HAIKU);
    await s.model(QWEN, { roles: [] });
    expect(await s.listed(null)).toEqual([HAIKU]);
  });

  it("region_only keeps content in the region", async () => {
    const s = await setup();
    await s.policy(false, "local");
    expect(await s.listed()).toEqual([QWEN, "ollama/llama3.2:3b"]);
  });

  it("combine with a matter's exclusions, so the strictest wins", async () => {
    const s = await setup();
    await s.policy(false, "local");
    await expect(
      s.gateway.call({ ...s.request(), exclude: [QWEN, "ollama/llama3.2:3b"] }),
    ).rejects.toMatchObject({ code: "NO_ALLOWED_MODEL" });
    expect(s.calls).toEqual({ anthropic: 0, ollama: 0 });
  });

  it("apply to a change from the next call on", async () => {
    const s = await setup();
    expect((await s.gateway.call(s.request())).model).toBe(HAIKU);
    await s.policy(true);
    expect((await s.gateway.call(s.request())).model).toBe(QWEN);
  });

  it("refuse a workspace that can't be found", async () => {
    const s = await setup();
    await expect(
      s.gateway.call({ ...s.request(), routing: { workspace: randomUUID(), user: null } }),
    ).rejects.toMatchObject({ code: "SETTINGS_UNAVAILABLE" });
    expect(s.calls).toEqual({ anthropic: 0, ollama: 0 });
  });

  it("refuse everything when the database can't be read", async () => {
    const s = await setup();
    const down = new pg.Pool({ connectionString: "postgres://127.0.0.1:1/none" });
    const counting = countingProviders(() => "x");
    const gateway = createWorkspaceGateway(down, {
      providers: counting.providers,
      recordUsage: async () => {},
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(gateway.call(s.request())).rejects.toMatchObject({
      code: "SETTINGS_UNAVAILABLE",
    });
    // The cause is logged by code and workspace, never with the driver's message.
    expect(logged.mock.calls).toEqual([
      [`model settings read failed: workspace=${s.workspaceId} code=ECONNREFUSED`],
    ]);
    logged.mockRestore();
    expect(counting.calls).toEqual({ anthropic: 0, ollama: 0 });
    await down.end();
  });

  it("apply to intake classification, which has no matter and no person", async () => {
    const s = await setup();
    await s.model(HAIKU, { enabled: false });
    await expect(
      classify(s.gateway, {
        types: [
          { id: randomUUID(), name: "NDA", description: "", keyword_rules: [], fields: [] },
          { id: randomUUID(), name: "MSA", description: "", keyword_rules: [], fields: [] },
        ],
        fixed: null,
        text: "Please review this.",
        asked: null,
        workspace: s.workspaceId,
        trace: "t",
      }),
    ).rejects.toMatchObject({ code: "NO_ALLOWED_MODEL" });
    expect(s.calls).toEqual({ anthropic: 0, ollama: 0 });
  });

  it("apply to the Word pane's proofread and translate", async () => {
    const s = await setup();
    await s.model(HAIKU, { enabled: false });
    const language = createLanguage(s.gateway);
    const who = { workspace: s.workspaceId, user: s.userId };
    expect(await language.proofread(who, ["x"])).toEqual({
      ok: false,
      reason: "MODEL_NOT_ALLOWED",
    });
    expect(await language.translate(who, ["x"], "French")).toEqual({
      ok: false,
      reason: "MODEL_NOT_ALLOWED",
    });
    expect(s.calls).toEqual({ anthropic: 0, ollama: 0 });
  });
});

describe("a question asked under the workspace's model settings", () => {
  async function asking() {
    const s = await setup();
    const documents = testDocuments(pool);
    const { threads } = testThreads(pool, documents, {}, undefined, undefined, {
      gateway: s.gateway,
    });
    const principal = { sessionId: "s", userId: s.userId, workspaceId: s.workspaceId };
    const ask = (model?: string) =>
      threads.ask(
        principal,
        {
          blocks: [{ type: "text", text: "What is the notice period?" }],
          scope: { document_ids: [], vault_ids: [], sources: [] },
          ...(model ? { model } : {}),
        },
        { ip: null, userAgent: null },
      );
    return { ...s, ask };
  }

  it("ADM-005-a: refuses a chosen model the person may not use", async () => {
    const s = await asking();
    await s.model(HAIKU);
    expect(await s.ask(QWEN)).toMatchObject({ ok: false, reason: "MODEL_NOT_ALLOWED" });
    expect(s.calls).toEqual({ anthropic: 0, ollama: 0 });
  });

  it("ADM-005-b: refuses before any provider call when no model qualifies", async () => {
    const s = await asking();
    await s.policy(true, "eu");
    expect(await s.ask()).toMatchObject({ ok: false, reason: "MODEL_NOT_ALLOWED" });
    expect(s.calls).toEqual({ anthropic: 0, ollama: 0 });
  });
});

describe("a refusal no caller turned into its own", () => {
  const answering = async (error: GatewayError) => {
    const app = createApp({
      auth: createAuth(pool),
      documents: testDocuments(pool),
      threads: testThreads(pool, testDocuments(pool)),
      drafts: createDrafts(pool, { gateway: testThreads(pool, testDocuments(pool)).gateway }),
      clientIp: () => "203.0.113.9",
    });
    app.get("/boom", () => {
      throw error;
    });
    const res = await app.request("/boom");
    return [res.status, ((await res.json()) as { code: string }).code];
  };

  it("is answered as a refusal, or as unavailable when the settings can't be read", async () => {
    expect(await answering(new GatewayError("NO_ALLOWED_MODEL", []))).toEqual([
      403,
      "MODEL_NOT_ALLOWED",
    ]);
    expect(await answering(new GatewayError("SETTINGS_UNAVAILABLE", []))).toEqual([
      503,
      "MODEL_UNAVAILABLE",
    ]);
  });
});

// A gateway built any other way would skip the workspace's settings.
describe("gateway construction", () => {
  const src = fileURLToPath(new URL("..", import.meta.url));
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.ts$/.test(entry.name) && !/(\.test\.ts$|^test-)/.test(entry.name) ? [path] : [];
    });

  it("happens only where the workspace's settings are attached", () => {
    const builders = sources(src)
      .filter((path) => /\bcreateGateway\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(src, path));
    expect(builders).toEqual(["admin-models/gateway.ts"]);
  });
});
