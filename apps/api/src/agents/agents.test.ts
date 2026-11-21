import { randomUUID } from "node:crypto";
import { createGateway } from "@legallabs/model-gateway";
import { createLocalEngine, type RunHandler } from "@legallabs/runs";
import { strToU8, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { createAgentRuns } from "../agent-runs/runs.js";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
import { createDrafts } from "../drafts/drafts.js";
import { createTemplatePort } from "../library/port.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { createAgents } from "./agents.js";
import { createAgentSharing } from "./config.js";
import type { SpacePort } from "./ports.js";

const pool = testPool();
afterAll(() => pool.end());

// A workspace with one admin ("owner") and members whose permissions each test picks.
async function workspace(members: Record<string, string[]>) {
  const admin = await seedMember(pool, { permissions: ["*"] });
  const people: Record<string, Seeded> = { admin };
  for (const [name, permissions] of Object.entries(members)) {
    const roleId = (
      await pool.query<{ id: string }>(
        "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
        [admin.workspaceId, `role-${name}-${randomUUID().slice(0, 4)}`, permissions],
      )
    ).rows[0]?.id;
    const email = `${name}@${admin.slug}.test`;
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
    people[name] = { slug: admin.slug, workspaceId: admin.workspaceId, userId, email };
  }
  return people;
}

const waiting: RunHandler = {
  async plan() {
    return {
      plan: { steps: [], estimated_cost_usd: { low: 0, high: 0 }, editable: false },
      requiresApproval: true,
    };
  },
  step: async () => ({ kind: "done" }),
  answer: async () => {},
  verify: async () => ({ ok: true }),
};

function harness(opts: { spaces?: SpacePort; now?: () => Date } = {}) {
  const engine = createLocalEngine({ pool, handlers: { agent: waiting } });
  const runs = createAgentRuns(pool, { engine });
  const documents = testDocuments(pool);
  const agents = createAgents(pool, {
    ...(opts.spaces ? { spaces: opts.spaces } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: testThreads(pool, documents),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
      templates: createTemplatePort(pool),
    }),
    agentRuns: runs,
    agents,
    agentSharing: createAgentSharing(pool),
    clientIp: () => "203.0.113.9",
  });
  const cookies = new Map<string, string>();
  const signIn = async (m: Pick<Seeded, "slug" | "email">) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
    });
    const c = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    cookies.set(m.email, c);
    return c;
  };
  const call = async (who: Seeded, method: string, path: string, json?: unknown) => {
    const cookie = cookies.get(who.email) ?? (await signIn(who));
    app.onError((e) => {
      console.error("ERR", e);
      return new Response("x", { status: 500 });
    });
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const upload = async (who: Seeded, path: string, name: string, bytes: Uint8Array) => {
    const cookie = cookies.get(who.email) ?? (await signIn(who));
    const form = new FormData();
    form.set("file", new File([new Uint8Array(bytes)], name));
    const res = await app.request(`/api/v1${path}`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { app, engine, call, upload };
}

type H = ReturnType<typeof harness>;
// A saved, live agent owned by `who`.
async function liveAgent(h: H, who: Seeded, title = "NDA review") {
  const created = await h.call(who, "POST", "/agents", { title, mode: "scratch" });
  const id = created.body.agent.id as string;
  const saved = await h.call(who, "POST", `/agents/${id}/versions`, {
    instructions: "Review the NDA.",
    promote: true,
  });
  expect(saved.status).toBe(201);
  return id;
}

// A version-7 id, which ids in this API must be.
const V7 = "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d4f";
const BUILDER = ["agents.use", "agents.build", "threads.use"];
const USER = ["agents.use", "threads.use"];

describe("creating and saving (AGT-001, AGT-002)", () => {
  it("creates a draft agent, saves a draft, then promotes it", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER });
    const created = await h.call(p.bea as Seeded, "POST", "/agents", { mode: "describe" });
    expect(created.status).toBe(201);
    expect(created.body.agent).toMatchObject({
      title: "Untitled agent",
      status: "draft",
      my_access: "full",
    });
    const id = created.body.agent.id;

    const draft = await h.call(p.bea as Seeded, "POST", `/agents/${id}/versions`, {
      instructions: "",
      promote: false,
    });
    expect(draft.status).toBe(201);
    expect((await h.call(p.bea as Seeded, "GET", `/agents/${id}`)).body.agent.status).toBe("draft");

    const live = await h.call(p.bea as Seeded, "POST", `/agents/${id}/versions`, {
      instructions: "Check the term.",
      promote: true,
    });
    expect(live.body.version.no).toBe(3);
    const got = (await h.call(p.bea as Seeded, "GET", `/agents/${id}`)).body.agent;
    expect(got).toMatchObject({
      status: "live",
      draft_version_id: null,
      live_version_id: live.body.version.id,
    });
  });

  it("refuses an empty save, 51 attachments and duplicate labels", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = (await h.call(bea, "POST", "/agents", { mode: "scratch" })).body.agent.id;
    expect(
      (await h.call(bea, "POST", `/agents/${id}/versions`, { instructions: " ", promote: true }))
        .body.code,
    ).toBe("AGENT_EMPTY_INSTRUCTIONS");
    const att = (n: number) => ({ label: `a${n}`, kind: "vault", ref: `r${n}`, name: `V${n}` });
    const many = await h.call(bea, "POST", `/agents/${id}/versions`, {
      instructions: "x",
      attachments: Array.from({ length: 51 }, (_, i) => att(i)),
      promote: true,
    });
    expect(many).toMatchObject({ status: 400, body: { code: "AGENT_ATTACHMENT_LIMIT" } });
    const dup = await h.call(bea, "POST", `/agents/${id}/versions`, {
      instructions: "x",
      attachments: [att(1), att(1)],
      promote: false,
    });
    expect(dup.body.code).toBe("AGENT_LABEL_DUPLICATE");
  });

  it("warns about an @label nothing defines", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = (await h.call(bea, "POST", "/agents", { mode: "scratch" })).body.agent.id;
    const r = await h.call(bea, "POST", `/agents/${id}/versions`, {
      instructions: "Use @playbook and @missing.",
      attachments: [{ label: "playbook", kind: "vault", ref: "r", name: "P" }],
      promote: false,
    });
    expect(r.body.warnings).toEqual([{ code: "UNRESOLVED_LABEL", label: "@missing" }]);
  });

  it("shows a word diff between versions and what was added or dropped", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = (await h.call(bea, "POST", "/agents", { mode: "scratch" })).body.agent.id;
    const v1 = (
      await h.call(bea, "POST", `/agents/${id}/versions`, {
        instructions: "Review the NDA.",
        promote: true,
      })
    ).body.version;
    const v2 = (
      await h.call(bea, "POST", `/agents/${id}/versions`, {
        instructions: "Review the MSA.",
        attachments: [{ label: "p", kind: "vault", ref: "r", name: "P" }],
        promote: false,
      })
    ).body.version;
    const diff = (await h.call(bea, "GET", `/agents/${id}/versions/${v1.id}/diff/${v2.id}`)).body;
    expect(diff.instructions_diff.filter((o: { op: string }) => o.op !== "equal")).toEqual([
      { op: "delete", text: "NDA." },
      { op: "insert", text: "MSA." },
    ]);
    expect(diff.attachments.added).toHaveLength(1);
    // v1 is still live: saving a draft left it alone.
    expect((await h.call(bea, "GET", `/agents/${id}`)).body.agent.live_version_id).toBe(v1.id);
  });

  it("only lets builders create, and a Run grantee neither read nor edit", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER, rae: USER });
    const bea = p.bea as Seeded;
    const rae = p.rae as Seeded;
    expect(
      (await h.call(rae, "POST", "/agents", { mode: "scratch" })).status,
    ).toBeGreaterThanOrEqual(400);
    const id = await liveAgent(h, bea);
    await h.call(bea, "POST", `/agents/${id}/shares`, {
      principal_type: "user",
      principal_id: rae.userId,
      level: "run",
    });
    const seen = await h.call(rae, "GET", `/agents/${id}`);
    expect(seen.body.agent.my_access).toBe("run");
    expect((await h.call(rae, "GET", `/agents/${id}/versions`)).body.versions).toEqual([]);
    expect((await h.call(rae, "PATCH", `/agents/${id}`, { title: "Mine" })).status).toBe(403);
    expect(
      (await h.call(rae, "POST", `/agents/${id}/versions`, { instructions: "x", promote: false }))
        .status,
    ).toBe(403);
    expect((await h.call(rae, "DELETE", `/agents/${id}`)).status).toBe(403);
  });

  it("keeps an agent hidden from everyone it isn't shared with", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER, rae: USER });
    const id = await liveAgent(h, p.bea as Seeded);
    expect((await h.call(p.rae as Seeded, "GET", `/agents/${id}`)).status).toBe(404);
    expect((await h.call(p.rae as Seeded, "GET", "/agents")).body.agents).toEqual([]);
  });

  it("deletes softly and drops it from lists", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = await liveAgent(h, bea);
    expect((await h.call(bea, "DELETE", `/agents/${id}`)).status).toBe(204);
    expect((await h.call(bea, "GET", "/agents")).body.agents).toEqual([]);
    expect((await auditTrail(pool, bea.workspaceId)).map((e) => e.action)).toContain(
      "agent.deleted",
    );
  });
});

describe("approval matrix (AGT-005)", () => {
  it("grants a share to a person or group at once", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER, rae: USER });
    const bea = p.bea as Seeded;
    const rae = p.rae as Seeded;
    const id = await liveAgent(h, bea);
    const group = (
      await pool.query<{ id: string }>(
        `insert into core."group" (workspace_id, name, visibility) values ($1, 'team', 'private') returning id`,
        [bea.workspaceId],
      )
    ).rows[0]?.id;
    await pool.query(
      "insert into core.group_member (workspace_id, group_id, user_id) values ($1, $2, $3)",
      [bea.workspaceId, group, rae.userId],
    );
    const toGroup = await h.call(bea, "POST", `/agents/${id}/shares`, {
      principal_type: "group",
      principal_id: group,
      level: "run",
    });
    expect(toGroup).toMatchObject({ status: 201, body: { outcome: "granted" } });
    expect((await h.call(rae, "GET", `/agents/${id}`)).status).toBe(200);
    expect((await auditTrail(pool, bea.workspaceId)).map((e) => e.action)).toContain(
      "share.granted",
    );
  });

  it("holds a whole-workspace share for an agents admin, who accepts it", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER, rae: USER });
    const bea = p.bea as Seeded;
    const rae = p.rae as Seeded;
    const id = await liveAgent(h, bea);
    const req = await h.call(bea, "POST", `/agents/${id}/shares`, {
      principal_type: "workspace",
      level: "run",
    });
    expect(req).toMatchObject({ status: 202, body: { outcome: "pending" } });
    expect((await h.call(rae, "GET", `/agents/${id}`)).status).toBe(404);

    // The requester and ordinary members don't see the queue; an agents admin does.
    expect((await h.call(bea, "GET", "/admin/sharing/requests")).status).toBe(403);
    const queue = await h.call(p.admin as Seeded, "GET", "/admin/sharing/requests");
    expect(queue.body.requests).toMatchObject([
      { resource_id: id, principal_type: "workspace", approver: "agents_admin" },
    ]);

    expect(
      (await h.call(bea, "POST", `/admin/sharing/requests/${req.body.id}/accept`, {})).status,
    ).toBe(403);
    expect(
      (await h.call(p.admin as Seeded, "POST", `/admin/sharing/requests/${req.body.id}/accept`, {}))
        .status,
    ).toBe(204);
    expect((await h.call(rae, "GET", `/agents/${id}`)).body.agent.my_access).toBe("run");
    const actions = (await auditTrail(pool, bea.workspaceId)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["share.requested", "share.accepted"]));
  });

  it("lets an agents admin share workspace-wide without waiting", async () => {
    const h = harness();
    const p = await workspace({ rae: USER });
    const admin = p.admin as Seeded;
    const id = await liveAgent(h, admin);
    const r = await h.call(admin, "POST", `/agents/${id}/shares`, {
      principal_type: "workspace",
      level: "run",
    });
    expect(r).toMatchObject({ status: 201, body: { outcome: "granted" } });
    expect((await h.call(p.rae as Seeded, "GET", `/agents/${id}`)).status).toBe(200);
  });

  it("blocks asking again for 7 days after a denial", async () => {
    let clock = new Date("2026-03-01T00:00:00Z");
    const h = harness({ now: () => clock });
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = await liveAgent(h, bea);
    const first = await h.call(bea, "POST", `/agents/${id}/shares`, {
      principal_type: "workspace",
      level: "run",
    });
    const deny = await h.call(
      p.admin as Seeded,
      "POST",
      `/admin/sharing/requests/${first.body.id}/deny`,
      { reason: "not yet" },
    );
    expect(deny.status).toBe(204);
    const again = await h.call(bea, "POST", `/agents/${id}/shares`, {
      principal_type: "workspace",
      level: "run",
    });
    expect(again).toMatchObject({ status: 409, body: { code: "SHARE_REQUEST_COOLDOWN" } });
    clock = new Date(Date.now() + 8 * 86_400_000);
    const later = await h.call(bea, "POST", `/agents/${id}/shares`, {
      principal_type: "workspace",
      level: "run",
    });
    expect(later.status).toBe(202);
  });

  it("refuses Edit for someone without agents.build", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER, rae: USER });
    const id = await liveAgent(h, p.bea as Seeded);
    const r = await h.call(p.bea as Seeded, "POST", `/agents/${id}/shares`, {
      principal_type: "user",
      principal_id: (p.rae as Seeded).userId,
      level: "edit",
    });
    expect(r).toMatchObject({ status: 400, body: { code: "LEVEL_REQUIRES_BUILD_PERMISSION" } });
  });

  it("follows the admin switches: approval for groups on, for the workspace off", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const admin = p.admin as Seeded;
    const id = await liveAgent(h, bea);
    const group = (
      await pool.query<{ id: string }>(
        `insert into core."group" (workspace_id, name, visibility) values ($1, 'g', 'private') returning id`,
        [bea.workspaceId],
      )
    ).rows[0]?.id;
    expect(
      (
        await h.call(bea, "PUT", "/admin/config/sharing", {
          require_approval: { individual: false, group: true, workspace: false },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.call(admin, "PUT", "/admin/config/sharing", {
          require_approval: { individual: false, group: true, workspace: false },
        })
      ).status,
    ).toBe(200);
    expect((await h.call(bea, "GET", "/admin/config/sharing")).body.require_approval).toEqual({
      individual: false,
      group: true,
      workspace: false,
    });
    expect(
      (
        await h.call(bea, "POST", `/agents/${id}/shares`, {
          principal_type: "group",
          principal_id: group,
          level: "run",
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await h.call(bea, "POST", `/agents/${id}/shares`, {
          principal_type: "workspace",
          level: "run",
        })
      ).status,
    ).toBe(201);
  });

  it("sends an external Space's request to that Space's admins, not the workspace admins", async () => {
    const space = V7;
    const h = harness({
      spaces: {
        info: async (_p, id) =>
          id === space ? { external: true, requesterIsAdmin: false, mayInvite: true } : null,
      },
    });
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = await liveAgent(h, bea);
    const r = await h.call(bea, "POST", `/agents/${id}/shares`, {
      principal_type: "space",
      principal_id: space,
      level: "run",
    });
    expect(r.status).toBe(202);
    const approver = (
      await pool.query("select approver from work.share_request where id = $1", [r.body.id])
    ).rows[0];
    expect(approver).toEqual({ approver: "space_admin" });
    // Not in the workspace admins' queue, and they can't decide it.
    expect(
      (await h.call(p.admin as Seeded, "GET", "/admin/sharing/requests")).body.requests,
    ).toEqual([]);
    expect(
      (await h.call(p.admin as Seeded, "POST", `/admin/sharing/requests/${r.body.id}/accept`, {}))
        .status,
    ).toBe(403);
  });

  it("refuses a Space the requester can't invite to, and any Space before Spaces exist", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER });
    const id = await liveAgent(h, p.bea as Seeded);
    const r = await h.call(p.bea as Seeded, "POST", `/agents/${id}/shares`, {
      principal_type: "space",
      principal_id: V7,
      level: "run",
    });
    expect(r).toMatchObject({ status: 403, body: { code: "SPACE_INVITE_DENIED" } });
  });

  it("lets only Full access list and revoke shares", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER, rae: USER });
    const bea = p.bea as Seeded;
    const rae = p.rae as Seeded;
    const id = await liveAgent(h, bea);
    const granted = await h.call(bea, "POST", `/agents/${id}/shares`, {
      principal_type: "user",
      principal_id: rae.userId,
      level: "view",
    });
    expect((await h.call(rae, "GET", `/agents/${id}/shares`)).status).toBe(403);
    const shares = (await h.call(bea, "GET", `/agents/${id}/shares`)).body;
    expect(shares.grants).toHaveLength(1);
    expect((await h.call(rae, "DELETE", `/agents/${id}/shares/${granted.body.id}`)).status).toBe(
      403,
    );
    expect((await h.call(bea, "DELETE", `/agents/${id}/shares/${granted.body.id}`)).status).toBe(
      204,
    );
    expect((await h.call(rae, "GET", `/agents/${id}`)).status).toBe(404);
  });
});

describe("running (AGT-003)", () => {
  it("starts a run in a new thread from the Agents page, and pins the live version", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = await liveAgent(h, bea);
    const started = await h.call(bea, "POST", `/agents/${id}/run`, { inputs: "go" });
    expect(started.status).toBe(202);
    const row = (
      await pool.query(
        "select kind, subject_id, agent_version_id, path from work.run where id = $1",
        [started.body.run_id],
      )
    ).rows[0];
    const live = (await h.call(bea, "GET", `/agents/${id}`)).body.agent.live_version_id;
    expect(row).toEqual({ kind: "agent", subject_id: id, agent_version_id: live, path: "page" });
    await h.engine.signal(started.body.run_id, { name: "cancel", reason: "cleanup" });
    await h.engine.result(started.body.run_id);

    // A later promotion does not move a run already started.
    const next = await h.call(bea, "POST", `/agents/${id}/versions`, {
      instructions: "Other.",
      promote: true,
    });
    const after = (
      await pool.query("select agent_version_id from work.run where id = $1", [started.body.run_id])
    ).rows[0];
    expect(after.agent_version_id).toBe(live);
    expect(next.body.version.id).not.toBe(live);
  });

  it("won't run an agent that was never saved, or one shared with nobody", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER, rae: USER });
    const bea = p.bea as Seeded;
    const draft = (await h.call(bea, "POST", "/agents", { mode: "scratch" })).body.agent.id;
    expect((await h.call(bea, "POST", `/agents/${draft}/run`, {})).status).toBe(409);
    const id = await liveAgent(h, bea);
    expect((await h.call(p.rae as Seeded, "POST", `/agents/${id}/run`, {})).status).toBe(404);
  });

  it("lets a Run grantee run the agent", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER, rae: USER });
    const id = await liveAgent(h, p.bea as Seeded);
    await h.call(p.bea as Seeded, "POST", `/agents/${id}/shares`, {
      principal_type: "user",
      principal_id: (p.rae as Seeded).userId,
      level: "run",
    });
    const started = await h.call(p.rae as Seeded, "POST", `/agents/${id}/run`, { inputs: "hi" });
    expect(started.status).toBe(202);
    // Pinning another version needs View.
    const pinned = await h.call(p.rae as Seeded, "POST", `/agents/${id}/run`, {
      version_id: V7,
    });
    expect(pinned.status).toBe(403);
    await h.engine.signal(started.body.run_id, { name: "cancel", reason: "cleanup" });
    await h.engine.result(started.body.run_id);
    // The owner sees the run in the agent's counts, as a Full-access holder.
    expect((await h.call(p.bea as Seeded, "GET", `/agents/${id}`)).body.agent.stats.runs).toBe(1);
  });
});

describe("schedules (AGT-004)", () => {
  const weekly = {
    rule: "weekly",
    params: { weekdays: [1, 4] },
    time_local: "08:00",
    tz: "Europe/London",
    email: false,
  };

  it("computes the next run in UTC across daylight saving, one schedule per user", async () => {
    const h = harness({ now: () => new Date("2026-03-26T09:00:00Z") });
    const p = await workspace({ bea: BUILDER, rae: USER });
    const bea = p.bea as Seeded;
    const id = await liveAgent(h, bea);
    await h.call(bea, "POST", `/agents/${id}/shares`, {
      principal_type: "user",
      principal_id: (p.rae as Seeded).userId,
      level: "run",
    });
    const first = await h.call(bea, "PUT", `/agents/${id}/schedule`, weekly);
    expect(first.body.schedule.next_run_at).toBe("2026-03-30T07:00:00.000Z");
    const second = await h.call(p.rae as Seeded, "PUT", `/agents/${id}/schedule`, {
      ...weekly,
      time_local: "09:00",
    });
    expect(second.status).toBe(200);
    await h.call(bea, "PUT", `/agents/${id}/schedule`, { ...weekly, time_local: "10:00" });
    const rows = (
      await pool.query(
        "select user_id, time_local from work.agent_schedule where agent_id = $1 order by time_local",
        [id],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect((await h.call(bea, "GET", `/agents/${id}`)).body.agent.schedule.time_local).toBe(
      "10:00",
    );
    expect((await h.call(bea, "GET", `/agents/${id}/activity`)).body.next_run_at).not.toBeNull();
  });

  it("needs a live version, and a valid rule", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const draft = (await h.call(bea, "POST", "/agents", { mode: "scratch" })).body.agent.id;
    expect((await h.call(bea, "PUT", `/agents/${draft}/schedule`, weekly)).body.code).toBe(
      "SCHEDULE_REQUIRES_LIVE",
    );
    const id = await liveAgent(h, bea);
    expect(
      (await h.call(bea, "PUT", `/agents/${id}/schedule`, { ...weekly, tz: "Mars/Base" })).status,
    ).toBe(400);
  });

  it("is paused, with its reason, when the agent is deleted", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = await liveAgent(h, bea);
    await h.call(bea, "PUT", `/agents/${id}/schedule`, weekly);
    await h.call(bea, "DELETE", `/agents/${id}`);
    const row = (
      await pool.query(
        "select status, paused_reason from work.agent_schedule where agent_id = $1",
        [id],
      )
    ).rows[0];
    expect(row).toEqual({ status: "paused", paused_reason: "agent_deleted" });
  });

  it("is removed on request", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = await liveAgent(h, bea);
    await h.call(bea, "PUT", `/agents/${id}/schedule`, weekly);
    expect((await h.call(bea, "DELETE", `/agents/${id}/schedule`)).status).toBe(204);
    expect((await h.call(bea, "DELETE", `/agents/${id}/schedule`)).status).toBe(404);
  });
});

describe("import and export (AGT-001)", () => {
  const skill = (files: Record<string, string>) =>
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

  it("previews an archive, then confirms it as a draft with no live version", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const bytes = skill({
      "SKILL.md": "---\nname: NDA pass\n---\nCheck the term.",
      "manifest.json": JSON.stringify({
        schema: "counsel.skill/1",
        name: "NDA pass",
        sources: [{ label: "cases", kind: "knowledge_source", source: "courtlistener" }],
      }),
    });
    const preview = await h.upload(bea, "/agents/import", "nda.skill", bytes);
    expect(preview.status).toBe(200);
    expect(preview.body.sources).toEqual([
      { label: "cases", source: "courtlistener", status: "unknown_source" },
    ]);
    const confirmed = await h.call(bea, "POST", `/agents/import/${preview.body.token}/confirm`, {
      drop_labels: [],
    });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.agent).toMatchObject({ title: "NDA pass", status: "draft" });
    const id = confirmed.body.agent.id;
    const versions = (await h.call(bea, "GET", `/agents/${id}/versions`)).body.versions;
    expect(versions[0]).toMatchObject({ instructions: "Check the term.", sources: [] });
    // The preview can't be confirmed twice.
    expect(
      (
        await h.call(bea, "POST", `/agents/import/${preview.body.token}/confirm`, {
          drop_labels: [],
        })
      ).status,
    ).toBe(410);
    expect((await auditTrail(pool, bea.workspaceId)).map((e) => e.action)).toContain(
      "agent.imported",
    );
  });

  it("rejects an archive with a path that leaves it, storing nothing", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const before = (
      await pool.query("select count(*)::int n from work.agent where workspace_id = $1", [
        bea.workspaceId,
      ])
    ).rows[0].n;
    const r = await h.upload(
      bea,
      "/agents/import",
      "bad.zip",
      skill({ "SKILL.md": "x", "../etc/passwd": "root" }),
    );
    expect(r).toMatchObject({ status: 400, body: { code: "SKILL_UNSAFE_ARCHIVE" } });
    const after = (
      await pool.query("select count(*)::int n from work.agent where workspace_id = $1", [
        bea.workspaceId,
      ])
    ).rows[0].n;
    expect(after).toBe(before);
  });

  it("exports the live version as a bundle that imports back", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = await liveAgent(h, bea, "Exported");
    const cookie =
      (
        await h.app.request("/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspace: bea.slug, email: bea.email, password: PASSWORD }),
        })
      ).headers
        .get("set-cookie")
        ?.split(";")[0] ?? "";
    const res = await h.app.request(`/api/v1/agents/${id}/export`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const back = await h.upload(
      bea,
      "/agents/import",
      "agent.skill",
      new Uint8Array(await res.arrayBuffer()),
    );
    expect(back.body).toMatchObject({ title: "Exported", instructions: "Review the NDA." });
  });
});

describe("duplicate", () => {
  it("copies the live version into a new draft agent owned by the duplicator", async () => {
    const h = harness();
    const p = await workspace({ bea: BUILDER, cam: BUILDER });
    const bea = p.bea as Seeded;
    const cam = p.cam as Seeded;
    const id = await liveAgent(h, bea, "Original");
    await h.call(bea, "POST", `/agents/${id}/shares`, {
      principal_type: "user",
      principal_id: cam.userId,
      level: "view",
    });
    const copy = await h.call(cam, "POST", `/agents/${id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.body.agent).toMatchObject({
      title: "Original (copy)",
      owner_id: cam.userId,
      status: "draft",
      my_access: "full",
    });
    expect(
      (await h.call(cam, "GET", `/agents/${copy.body.agent.id}/versions`)).body.versions[0]
        .instructions,
    ).toBe("Review the NDA.");
  });
});
