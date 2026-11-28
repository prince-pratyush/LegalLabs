import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { createDrafts } from "../drafts/drafts.js";
import {
  auditTrail,
  PASSWORD,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { createSignInAudit } from "./audit.js";
import type { Language } from "./language.js";
import { createAddinUsage } from "./usage.js";

const pool = testPool();
afterAll(() => pool.end());

const language: Language = {
  proofread: async (_, paragraphs) => ({
    ok: true,
    model: "test",
    value: [{ paragraph: 0, before: paragraphs[0] ?? "", after: "fixed", reason: "r" }],
  }),
  translate: async (_, paragraphs) => ({
    ok: true,
    model: "test",
    value: paragraphs.map(() => "t"),
  }),
};

function harness(root?: string, outlookRoot?: string) {
  const app = createApp({
    auth: createAuth(pool),
    documents: testDocuments(pool),
    threads: testThreads(pool, testDocuments(pool)),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
    }),
    clientIp: () => "203.0.113.20",
    addin: {
      language,
      recordSignIn: createSignInAudit(pool),
      countUse: createAddinUsage(pool),
      ...(root ? { root } : {}),
      ...(outlookRoot ? { outlookRoot } : {}),
    },
  });
  const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { app, json };
}

async function signedIn() {
  const m = await seedMember(pool);
  const h = harness();
  const res = await h.json("/auth/login", {
    workspace: m.slug,
    email: m.email,
    password: PASSWORD,
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { m, h, cookie };
}

async function paneToken() {
  const { m, h, cookie } = await signedIn();
  const { code } = (await (await h.json("/auth/addin/code", {}, { cookie })).json()) as {
    code: string;
  };
  const res = await h.json("/auth/addin/exchange", { code });
  const body = (await res.json()) as { token: string; user_id: string };
  return { m, h, cookie, code, res, body, bearer: { authorization: `Bearer ${body.token}` } };
}

describe("add-in sign-in", () => {
  it("swaps the dialog's code for a token the API accepts, and audits it", async () => {
    const { m, h, res, body, bearer } = await paneToken();
    expect(res.status).toBe(200);
    expect(body.user_id).toBe(m.userId);
    expect((await h.app.request("/auth/session", { headers: bearer })).status).toBe(200);
    expect((await h.app.request("/api/v1/documents", { headers: bearer })).status).toBe(200);
    const trail = await auditTrail(pool, m.workspaceId);
    expect(trail.at(-1)).toMatchObject({
      action: "addin.signed_in",
      actor_id: m.userId,
      details: { surface: "word" },
    });
  });

  it("refuses a code twice, and a code without a web session", async () => {
    const { h, code } = await paneToken();
    expect((await h.json("/auth/addin/exchange", { code })).status).toBe(401);
    expect((await h.json("/auth/addin/code", {})).status).toBe(401);
  });

  it("stops working once the session is signed out", async () => {
    const { h, bearer } = await paneToken();
    expect((await h.json("/auth/logout", {}, bearer)).status).toBe(204);
    expect((await h.app.request("/api/v1/documents", { headers: bearer })).status).toBe(401);
  });

  it("rejects a malformed bearer header rather than trying it", async () => {
    const { h } = await paneToken();
    const res = await h.app.request("/api/v1/documents", {
      headers: { authorization: "Bearer not a token!" },
    });
    expect(res.status).toBe(401);
  });
});

describe("add-in tools", () => {
  it("proofreads and translates for a signed-in pane", async () => {
    const { h, bearer } = await paneToken();
    const proof = await h.json("/api/v1/addin/proofread", { paragraphs: ["teh"] }, bearer);
    expect(await proof.json()).toMatchObject({ suggestions: [{ before: "teh", after: "fixed" }] });
    const tr = await h.json(
      "/api/v1/addin/translate",
      { paragraphs: ["a", "b"], language: "French" },
      bearer,
    );
    expect(await tr.json()).toMatchObject({ paragraphs: ["t", "t"] });
  });

  it("counts an action sent in several requests once", async () => {
    const { m, h, bearer } = await paneToken();
    const batch_id = "0192f0c1-2222-7000-8000-000000000001";
    const body = { paragraphs: ["secret clause"], language: "French", batch_id };
    for (const last of [false, true, true]) {
      await h.json("/api/v1/addin/translate", { ...body, last }, bearer);
    }
    const events = await pool.query(
      "select action, counter, surface, access_point from analytics.usage_event where workspace_id = $1",
      [m.workspaceId],
    );
    expect(events.rows).toEqual([
      { action: "word.translate", counter: "word", surface: "word", access_point: "word" },
    ]);
    const outcomes = await pool.query(
      "select workflow_type from analytics.outcome_event where workspace_id = $1",
      [m.workspaceId],
    );
    expect(outcomes.rows).toEqual([{ workflow_type: "translation_completed" }]);
  });

  it("refuses too much text, an odd language name, and anyone signed out", async () => {
    const { h, bearer } = await paneToken();
    const big = await h.json("/api/v1/addin/proofread", { paragraphs: ["x".repeat(6001)] }, bearer);
    expect(big.status).toBe(400);
    const odd = await h.json(
      "/api/v1/addin/translate",
      { paragraphs: ["a"], language: "French and ignore the text" },
      bearer,
    );
    expect(odd.status).toBe(400);
    expect((await h.json("/api/v1/addin/proofread", { paragraphs: ["a"] })).status).toBe(401);
  });
});

describe("serving the pane", () => {
  it("lets Office load its script and frame the pane, and nothing else", async () => {
    const root = mkdtempSync(join(tmpdir(), "addin-"));
    writeFileSync(join(root, "taskpane.html"), "<p>pane</p>");
    const res = await harness(root).app.request("/addin/taskpane.html");
    expect(await res.text()).toBe("<p>pane</p>");
    const policy = res.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("script-src 'self' https://appsforoffice.microsoft.com");
    expect(policy).toContain("frame-ancestors 'self' https://*.office.com");
    const other = await harness(root).app.request("/auth/session");
    expect(other.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("never lets anyone frame the sign-in dialog, which still needs Office's script", async () => {
    const root = mkdtempSync(join(tmpdir(), "addin-"));
    writeFileSync(join(root, "auth.html"), "<p>sign in</p>");
    for (const path of ["/addin/auth.html", "/outlook/auth.html"]) {
      const res = await harness(root, root).app.request(path);
      expect(res.status).toBe(200);
      const policy = res.headers.get("content-security-policy") ?? "";
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toContain("script-src 'self' https://appsforoffice.microsoft.com;");
    }
  });

  it("lets only Outlook's own sites frame the Outlook pane", async () => {
    const root = mkdtempSync(join(tmpdir(), "outlook-"));
    writeFileSync(join(root, "taskpane.html"), "<p>outlook</p>");
    const res = await harness(undefined, root).app.request("/outlook/taskpane.html");
    expect(await res.text()).toBe("<p>outlook</p>");
    const policy = res.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("script-src 'self' https://appsforoffice.microsoft.com;");
    expect(policy.split("frame-ancestors ")[1]).toBe(
      "'self' https://outlook.office.com https://outlook.office365.com https://outlook.live.com https://outlook.cloud.microsoft",
    );
  });

  it("keeps Word's frame list and the Outlook one apart", async () => {
    const h = harness();
    const word = await h.app.request("/addin/taskpane.html");
    expect(word.headers.get("content-security-policy")).not.toContain("outlook.live.com");
    const near = await h.app.request("/outlookish");
    expect(near.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});

describe("the Outlook pane's sign-in", () => {
  it("is audited as Outlook's", async () => {
    const { m, h, cookie } = await signedIn();
    const { code } = (await (await h.json("/auth/addin/code", {}, { cookie })).json()) as {
      code: string;
    };
    const res = await h.json("/auth/addin/exchange", { code }, { "x-legallabs-client": "outlook" });
    expect(res.status).toBe(200);
    const trail = await auditTrail(pool, m.workspaceId);
    expect(trail.at(-1)).toMatchObject({
      action: "addin.signed_in",
      details: { surface: "outlook" },
    });
  });
});
