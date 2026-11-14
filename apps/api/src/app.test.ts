import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { PASSWORD, seedMember, testDocuments, testPool } from "./test-db.js";
import { createThreads } from "./threads/threads.js";

const pool = testPool();
afterAll(() => pool.end());

function harness(ip = "203.0.113.9", webRoot?: string) {
  let time = 1_000_000;
  const app = createApp({
    auth: createAuth(pool),
    documents: testDocuments(pool),
    threads: createThreads(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
      documents: testDocuments(pool),
    }),
    clientIp: () => ip,
    now: () => time,
    ...(webRoot ? { webRoot } : {}),
  });
  const login = (body: unknown) =>
    app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const withCookie = (cookie: string) => ({ headers: { cookie } });
  return { app, login, withCookie, advance: (ms: number) => (time += ms) };
}

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

describe("POST /auth/login", () => {
  it("sets the session cookie with every protection, and never returns the token", async () => {
    const m = await seedMember(pool);
    const res = await harness().login({ workspace: m.slug, email: m.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: m.userId, workspace_id: m.workspaceId });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^__Host-sid=[\w-]{43};/);
    for (const part of ["Max-Age=43200", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) {
      expect(cookie).toContain(part);
    }
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("gives the same answer for a wrong password and an unknown workspace", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const wrong = await h.login({ workspace: m.slug, email: m.email, password: "not it at all" });
    const unknown = await h.login({ workspace: "nope", email: m.email, password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });

  it("retires the session it replaces", async () => {
    const m = await seedMember(pool);
    const h = harness();
    const body = JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD });
    const first = await h.login({ workspace: m.slug, email: m.email, password: PASSWORD });
    const second = await h.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieOf(first) },
      body,
    });
    expect((await h.app.request("/auth/session", h.withCookie(cookieOf(first)))).status).toBe(401);
    expect((await h.app.request("/auth/session", h.withCookie(cookieOf(second)))).status).toBe(200);
  });

  it("rejects a NUL byte instead of passing it to the database", async () => {
    const res = await harness().login({ workspace: "a", email: "b\0@c.d", password: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed or oversized request without trying it", async () => {
    const h = harness();
    expect((await h.login("{not json")).status).toBe(400);
    expect((await h.login({ workspace: "a", email: "b@c.d" })).status).toBe(400);
    const huge = { workspace: "a", email: "b@c.d", password: "x".repeat(257) };
    expect((await h.login(huge)).status).toBe(400);
  });

  it("stops a sixth try on one account within the minute, even with the right password", async () => {
    const m = await seedMember(pool);
    const h = harness();
    for (let i = 0; i < 5; i++) {
      expect((await h.login({ workspace: m.slug, email: m.email, password: "nope" })).status).toBe(
        401,
      );
    }
    const blocked = await h.login({ workspace: m.slug, email: m.email, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    h.advance(60_000);
    const later = await h.login({
      workspace: m.slug,
      email: m.email.toUpperCase(),
      password: PASSWORD,
    });
    expect(later.status).toBe(200);
  });

  it("counts an account the same however the email is capitalised", async () => {
    const m = await seedMember(pool);
    const h = harness();
    for (const email of [m.email, m.email.toUpperCase(), m.email, m.email, m.email]) {
      await h.login({ workspace: m.slug, email, password: "nope" });
    }
    const blocked = await h.login({ workspace: m.slug, email: m.email, password: PASSWORD });
    expect(blocked.status).toBe(429);
  });

  it("stops an eleventh try from one address across different accounts", async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) {
      await h.login({ workspace: "nope", email: `u${i}@example.test`, password: "nope" });
    }
    const blocked = await h.login({
      workspace: "nope",
      email: "u99@example.test",
      password: "nope",
    });
    expect(blocked.status).toBe(429);
  });
});

describe("a signed-in request", () => {
  const signIn = async () => {
    const m = await seedMember(pool);
    const h = harness();
    const res = await h.login({ workspace: m.slug, email: m.email, password: PASSWORD });
    return { m, h, cookie: cookieOf(res) };
  };

  it("sees who it is", async () => {
    const { m, h, cookie } = await signIn();
    const res = await h.app.request("/auth/session", h.withCookie(cookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: m.userId, workspace_id: m.workspaceId });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is refused without a cookie or with a made-up one", async () => {
    const h = harness();
    expect((await h.app.request("/auth/session")).status).toBe(401);
    const res = await h.app.request("/auth/session", h.withCookie("__Host-sid=made-up"));
    expect(res.status).toBe(401);
  });

  it("is refused after signing out, and the cookie is cleared", async () => {
    const { h, cookie } = await signIn();
    const out = await h.app.request("/auth/logout", { method: "POST", ...h.withCookie(cookie) });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/^__Host-sid=;.*Max-Age=0/);
    expect((await h.app.request("/auth/session", h.withCookie(cookie))).status).toBe(401);
  });
});

describe("a request from another site", () => {
  const post = (h: ReturnType<typeof harness>, origin?: string) =>
    h.app.request("http://localhost:8787/auth/logout", {
      method: "POST",
      headers: origin === undefined ? {} : { origin },
    });

  it("is refused when it would change something", async () => {
    const h = harness();
    for (const origin of ["https://evil.test", "http://localhost:9999", "null"]) {
      const res = await post(h, origin);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "FORBIDDEN_ORIGIN" });
    }
  });

  it("is allowed from the same origin or with no origin at all", async () => {
    const h = harness();
    expect((await post(h, "http://localhost:8787")).status).toBe(204);
    expect((await post(h)).status).toBe(204);
  });

  it("can still read", async () => {
    const h = harness();
    const res = await h.app.request("http://localhost:8787/auth/session", {
      headers: { origin: "https://evil.test" },
    });
    expect(res.status).toBe(401);
  });
});

describe("the web page", () => {
  const root = mkdtempSync(join(tmpdir(), "legallabs-web-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>LegalLabs</title>");

  it("is served from the same origin with a strict content policy", async () => {
    const h = harness("203.0.113.9", root);
    const res = await h.app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>LegalLabs</title>");
    expect(res.headers.get("content-security-policy")).toMatch(/^default-src 'self'/);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("puts the same policy on API answers", async () => {
    const h = harness();
    const res = await h.app.request("/auth/session");
    expect(res.headers.get("content-security-policy")).toMatch(/^default-src 'self'/);
  });

  it("doesn't hand out files outside its folder", async () => {
    const h = harness("203.0.113.9", root);
    expect((await h.app.request("/../package.json")).status).toBe(404);
    expect((await h.app.request("/%2e%2e/package.json")).status).toBe(404);
  });
});
