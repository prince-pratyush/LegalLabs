import { createGateway } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { createDrafts } from "../drafts/drafts.js";
import {
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { noKnowledge, noVaults } from "../threads/ports.js";
import { createFakeSearch } from "./fake.js";
import { createWebSources } from "./sources.js";

const pool = testPool();
afterAll(() => pool.end());

function harness() {
  const documents = testDocuments(pool);
  const search = createFakeSearch([]);
  const web = createWebSources(pool, {
    provider: search,
    fetcher: { fetch: async () => ({ ok: false, reason: "UNREACHABLE" }) },
  });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: { ...testThreads(pool, documents, {}, noVaults, noKnowledge, { web }), web },
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
    }),
    webSearch: web,
    clientIp: () => "203.0.113.9",
  });
  const signIn = async (m: Seeded) => {
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
      headers: { cookie, "content-type": "application/json" },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { signIn, call, search };
}

const webAsk = {
  content: "rent review",
  scope: { document_ids: [], vault_ids: [], sources: [{ source_id: "web" }] },
};

describe("web search over HTTP", () => {
  it("is absent from the picker and refused until an administrator turns it on", async () => {
    const h = harness();
    const cookie = await h.signIn(await seedMember(pool));
    expect((await h.call(cookie, "GET", "/scope-options")).body.sources).toEqual([]);
    expect(await h.call(cookie, "POST", "/threads", webAsk)).toMatchObject({
      status: 403,
      body: { code: "SOURCE_NOT_ALLOWED" },
    });
    expect((await h.call(cookie, "PUT", "/web-search/settings", { enabled: true })).status).toBe(
      204,
    );
    expect((await h.call(cookie, "GET", "/scope-options")).body.sources).toEqual([
      expect.objectContaining({ id: "web", notice: expect.stringContaining("search.invalid") }),
    ]);
    expect((await h.call(cookie, "POST", "/threads", webAsk)).status).toBe(202);
  });

  it("refuses settings changes without admin.config, and bad input", async () => {
    const h = harness();
    const cookie = await h.signIn(await seedMember(pool, { permissions: ["threads.use"] }));
    expect(await h.call(cookie, "PUT", "/web-search/settings", { enabled: true })).toMatchObject({
      status: 403,
      body: { code: "FORBIDDEN" },
    });
    expect((await h.call(cookie, "GET", "/web-search/settings")).body).toEqual({
      configured: true,
      enabled: false,
      provider_host: "search.invalid",
      can_manage: false,
      blocked_matter_ids: [],
    });
    expect((await h.call(cookie, "PUT", "/web-search/settings", { enabled: "yes" })).status).toBe(
      400,
    );
    expect(
      (await h.call(cookie, "PUT", "/web-search/matters/nope", { blocked: true })).status,
    ).toBe(400);
  });

  it("keeps a matter out of the picker", async () => {
    const h = harness();
    const m = await seedMember(pool);
    const cookie = await h.signIn(m);
    const { rows } = await pool.query<{ id: string }>(
      `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name)
       values ($1, 'c', 'Client', '1', 'Matter') returning id`,
      [m.workspaceId],
    );
    const id = rows[0]?.id;
    await h.call(cookie, "PUT", "/web-search/settings", { enabled: true });
    expect(
      (await h.call(cookie, "PUT", `/web-search/matters/${id}`, { blocked: true })).status,
    ).toBe(204);
    expect((await h.call(cookie, "GET", `/scope-options?matter_id=${id}`)).body.sources).toEqual(
      [],
    );
    expect((await h.call(cookie, "GET", "/scope-options")).body.sources).toHaveLength(1);
  });
});
