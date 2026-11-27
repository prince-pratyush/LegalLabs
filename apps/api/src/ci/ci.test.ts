import { randomUUID } from "node:crypto";
import type { Finding, Gap, Rule } from "@legallabs/contracts";
import { buildDocx } from "@legallabs/docx";
import { createGateway } from "@legallabs/model-gateway";
import type { ReviewOutcome, runReview } from "@legallabs/review";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
import { asApp } from "../db.js";
import { createDrafts } from "../drafts/drafts.js";
import { createIntake } from "../intake/intake.js";
import { createHub } from "../notifications/hub.js";
import { createNotifier } from "../notifications/notify.js";
import { createPlaybooks } from "../playbooks/playbooks.js";
import { createReviews } from "../reviews/reviews.js";
import { createRunLog } from "../runs/log.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
} from "../test-db.js";
import { noKnowledge, noVaults } from "../threads/ports.js";
import { createThreads } from "../threads/threads.js";
import { createVaults } from "../vaults/vaults.js";
import { type CiOptions, createCi } from "./ci.js";

const pool = testPool();
afterAll(() => pool.end());

// biome-ignore lint/suspicious/noExplicitAny: test responses are checked field by field.
type Json = any;

type Verdicts = Record<string, Finding["status"]>;

/** Stands in for the review engine: each rule gets the verdict the test asked for. */
const engine =
  (verdicts: () => Verdicts, gate: () => Promise<void>): typeof runReview =>
  async (input) => {
    await gate();
    if (verdicts().crash) throw new Error("engine broke");
    const results: Finding[] = input.rules.map((rule) => ({
      rule_id: rule.id,
      rule_title: rule.title,
      status: verdicts()[rule.title] ?? "acceptable",
      flag: rule.flag,
      evidence: [],
      matched: "standard",
      explanation: "Checked.",
      verification: "ok",
      model: "fake/model",
      usage: { input_tokens: 1, output_tokens: 1 },
      cost_usd: 0,
    }));
    const gaps: Gap[] = [];
    const count = (s: string) => results.filter((f) => f.status === s).length;
    const usage = {
      input_tokens: 1,
      output_tokens: 1,
      cost_usd: 0,
      models: ["fake/model"],
      calls: 1,
    };
    const outcome: ReviewOutcome = {
      clause_map: {},
      uncovered: [],
      results,
      gaps,
      summary: {
        acceptable: count("acceptable"),
        needs_review: count("needs_review"),
        not_acceptable: count("not_acceptable"),
        not_found: count("not_found"),
        gaps: 0,
      },
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0, models: ["fake/model"] },
      phases: { plan: usage, rules: {}, verify: usage },
      coverage: { paragraphs: input.paragraphs.length, read: input.paragraphs.length },
      warnings: [],
      aborted: input.signal?.aborted === true,
    };
    return outcome;
  };

function harness(options: { maxActive?: number; ci?: Partial<CiOptions> } = {}) {
  const state: {
    verdicts: Verdicts;
    held: Promise<void> | null;
    /** Runs between the queue reading a contract and writing what became of it. */
    onGet?: () => Promise<void>;
    /** Runs once a playbook review has been started and committed. */
    onStarted?: () => void;
  } = { verdicts: {}, held: null };
  const documents = testDocuments(pool);
  const vaults = createVaults(pool, { documents, store: documents.store });
  const gateway = createGateway({ providers: {}, recordUsage: async () => {} });
  const log = createRunLog(pool);
  const reviews = createReviews(pool, {
    gateway,
    store: documents.store,
    log,
    run: engine(
      () => state.verdicts,
      async () => {
        await state.held;
      },
    ),
    ...(options.maxActive ? { maxActive: options.maxActive } : {}),
  });
  const ci = createCi(pool, {
    reviews: {
      async start(...args) {
        const started = await reviews.start(...args);
        state.onStarted?.();
        return started;
      },
      async get(...args) {
        const review = await reviews.get(...args);
        await state.onGet?.();
        return review;
      },
    },
    notifier: createNotifier(pool, createHub()),
    retrySeconds: 0,
    pollSeconds: 0,
    ...options.ci,
  });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    vaults,
    threads: {
      gateway,
      log,
      vaults: noVaults,
      knowledge: noKnowledge,
      threads: createThreads(pool, {
        gateway,
        documents,
        log,
        vaults: noVaults,
        knowledge: noKnowledge,
      }),
    },
    drafts: createDrafts(pool, { gateway }),
    playbooks: createPlaybooks(pool, { gateway }),
    reviews,
    ci,
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
  const call = async (
    who: Person,
    method: string,
    path: string,
    json?: unknown,
  ): Promise<{ status: number; body: Json }> => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: {
        cookie: who.cookie,
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const workspace = async (): Promise<Person> => {
    const m = await seedMember(pool);
    return { ...m, cookie: await signIn(m) };
  };

  const member = async (
    ws: Person,
    permissions = ["threads.use", "playbooks.use"],
  ): Promise<Person> => {
    const email = `u-${randomUUID().slice(0, 8)}@${ws.slug}.test`;
    const role = await pool.query<{ id: string }>(
      "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
      [ws.workspaceId, email, permissions],
    );
    const user = await pool.query<{ id: string }>(
      `insert into core."user" (workspace_id, email, role_id, status)
       values ($1, $2, $3, 'active') returning id`,
      [ws.workspaceId, email, role.rows[0]?.id],
    );
    const userId = user.rows[0]?.id ?? "";
    await pool.query(
      "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
      [ws.workspaceId, userId, await hashPassword(PASSWORD)],
    );
    const m = { slug: ws.slug, email, userId, workspaceId: ws.workspaceId };
    return { ...m, cookie: await signIn(m) };
  };

  const group = async (ws: Person, members: Person[]) => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into core."group" (workspace_id, name) values ($1, $2) returning id`,
      [ws.workspaceId, `g-${randomUUID().slice(0, 8)}`],
    );
    const id = rows[0]?.id ?? "";
    for (const m of members) {
      await pool.query(
        "insert into core.group_member (workspace_id, group_id, user_id) values ($1, $2, $3)",
        [ws.workspaceId, id, m.userId],
      );
    }
    return id;
  };

  const playbook = async (owner: Person, readers: Person[] = [], publish = true) => {
    const created = await call(owner, "POST", "/playbooks", {
      name: "MSA positions",
      contract_type: "MSA",
      source: {
        kind: "scratch",
        rules: [
          { title: "Liability cap", standard_position: "Capped at fees paid.", flag: true },
          { title: "Term length", standard_position: "Two years or less." },
        ],
      },
    });
    expect(created.status).toBe(201);
    const made = created.body.playbook as { id: string; rules: Rule[] };
    if (publish) {
      expect((await call(owner, "POST", `/playbooks/${made.id}/publish`)).status).toBe(200);
    }
    if (readers.length) {
      const granted = await call(
        owner,
        "PUT",
        `/playbooks/${made.id}/grants`,
        readers.map((r) => ({ principal_type: "user", principal_id: r.userId, level: "view" })),
      );
      expect(granted.status).toBe(200);
    }
    return made.id;
  };

  /** A contract in a vault shared with the readers. */
  const contract = async (owner: Person, readers: Person[] = []) => {
    const vault = await call(owner, "POST", "/vaults", { name: `Inbound ${randomUUID()}` });
    expect(vault.status).toBe(201);
    const vaultId = vault.body.vault.id as string;
    const form = new FormData();
    form.set(
      "file",
      new File(
        [
          buildDocx({
            blocks: [{ kind: "paragraph", runs: [{ text: "1. Liability is unlimited." }] }],
            author: "Test",
            date: "2026-01-01T00:00:00Z",
          }) as Uint8Array<ArrayBuffer>,
        ],
        "msa.docx",
      ),
    );
    const res = await app.request(`/api/v1/vaults/${vaultId}/files`, {
      method: "POST",
      headers: { cookie: owner.cookie },
      body: form,
    });
    expect([201, 202]).toContain(res.status);
    const { file } = (await res.json()) as { file: { id: string; version_id: string } };
    await documents.worker.drain(owner.workspaceId);
    if (readers.length) {
      const shared = await call(owner, "PUT", `/vaults/${vaultId}/shares`, {
        grants: readers.map((r) => ({
          principal_type: "user",
          principal_id: r.userId,
          level: "view",
        })),
        workspace_view: false,
      });
      expect(shared.status).toBe(200);
    }
    return { documentId: file.id, versionId: file.version_id, vaultId };
  };

  /** A live agent; `assignment` defaults to a round robin over nobody, so the owner gets it. */
  const agent = async (owner: Person, playbookId: string, extra: Json = {}) => {
    const made = await call(owner, "POST", "/apps/ci/agents", {
      name: "MSA intake",
      contract_type: "MSA",
      playbook_id: playbookId,
      party: "Acme",
      assignment: [{ kind: "fixed", user_id: owner.userId }],
      ...extra,
    });
    expect(made.status).toBe(201);
    const id = made.body.agent.id as string;
    expect((await call(owner, "POST", `/apps/ci/agents/${id}/activate`)).status).toBe(200);
    return id;
  };

  const submit = async (who: Person, agentId: string, versionId: string, extra: Json = {}) => {
    const res = await call(who, "POST", "/apps/ci/reviews", {
      agent_id: agentId,
      document_version_id: versionId,
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body.review_id as string;
  };

  const get = async (who: Person, id: string) =>
    (await call(who, "GET", `/apps/ci/reviews/${id}`)).body.review;

  /** Ticks the queue until none of the reviews is waiting or running. */
  const settle = async (owner: Person, ...ids: string[]) => {
    for (let i = 0; i < 200; i++) {
      await ci.tick(owner.workspaceId);
      const found = await Promise.all(ids.map((id) => get(owner, id)));
      if (found.every((r) => !["queued", "running"].includes(r.status))) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("the queue did not settle");
  };

  const hold = () => {
    let release = () => {};
    state.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      release();
      state.held = null;
    };
  };

  return {
    app,
    ci,
    state,
    call,
    workspace,
    member,
    group,
    playbook,
    contract,
    agent,
    submit,
    get,
    settle,
    hold,
    documents,
  };
}

interface Person extends Seeded {
  cookie: string;
}

const notificationsFor = async (userId: string) =>
  (
    await pool.query<{ kind: string; action_required: boolean; url: string; title: string }>(
      `select kind, action_required, url, title from notify.notification
        where user_id = $1 and kind = 'ci.review_assigned'`,
      [userId],
    )
  ).rows;

/** Files the document under a matter the person is walled from. */
async function wallOff(ws: Person, userId: string, documentId: string) {
  const matter = await pool.query<{ id: string }>(
    `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name,
       wall_mode) values ($1, 'C1', 'Client', $2, 'Matter', 'open') returning id`,
    [ws.workspaceId, `M-${randomUUID().slice(0, 6)}`],
  );
  await pool.query(
    `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
     values ($1, $2, 'user', $3, 'deny')`,
    [ws.workspaceId, matter.rows[0]?.id, userId],
  );
  await pool.query("update content.document set matter_id = $1 where id = $2", [
    matter.rows[0]?.id,
    documentId,
  ]);
}

describe("review agents", () => {
  it("are created as drafts, changed, activated and paused by their owner only", async () => {
    const h = harness();
    const owner = await h.workspace();
    const playbookId = await h.playbook(owner, [], false);
    const body = {
      name: "MSA intake",
      contract_type: "MSA",
      playbook_id: playbookId,
      party: "Acme",
      assignment: [{ kind: "fixed", user_id: owner.userId }],
    };
    const made = await h.call(owner, "POST", "/apps/ci/agents", body);
    expect(made.status).toBe(201);
    expect(made.body.agent).toMatchObject({ status: "draft", paper: "theirs" });
    const id = made.body.agent.id as string;

    const early = await h.call(owner, "POST", `/apps/ci/agents/${id}/activate`);
    expect(early.body.code).toBe("NOT_PUBLISHED");
    expect((await h.call(owner, "POST", `/playbooks/${playbookId}/publish`)).status).toBe(200);
    const live = await h.call(owner, "POST", `/apps/ci/agents/${id}/activate`);
    expect(live.body.agent.status).toBe("live");

    const patched = await h.call(owner, "PATCH", `/apps/ci/agents/${id}`, { name: "Renamed" });
    expect(patched.body.agent).toMatchObject({ name: "Renamed", party: "Acme", status: "live" });
    const paused = await h.call(owner, "POST", `/apps/ci/agents/${id}/deactivate`);
    expect(paused.body.agent.status).toBe("paused");
    const listed = await h.call(owner, "GET", "/apps/ci/agents");
    expect(listed.body.agents.map((a: Json) => a.id)).toEqual([id]);

    const other = await h.member(owner, ["threads.use", "agents.build", "playbooks.create"]);
    expect((await h.call(other, "GET", "/apps/ci/agents")).body.agents).toEqual([]);
    expect((await h.call(other, "GET", `/apps/ci/agents/${id}`)).status).toBe(404);
    expect((await h.call(other, "PATCH", `/apps/ci/agents/${id}`, { name: "X" })).status).toBe(404);
    // Someone else's playbook that wasn't shared with them isn't there for them.
    expect((await h.call(other, "POST", "/apps/ci/agents", body)).status).toBe(404);

    expect((await auditTrail(pool, owner.workspaceId)).map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "ci.agent.created",
        "ci.agent.updated",
        "ci.agent.activated",
        "ci.agent.deactivated",
      ]),
    );
  });

  it("need agents.build and playbooks.create", async () => {
    const h = harness();
    const owner = await h.workspace();
    const playbookId = await h.playbook(owner);
    for (const permissions of [
      ["threads.use", "agents.build"],
      ["threads.use", "playbooks.create"],
    ]) {
      const who = await h.member(owner, permissions);
      const res = await h.call(who, "POST", "/apps/ci/agents", {
        name: "A",
        contract_type: "MSA",
        playbook_id: playbookId,
        party: "Acme",
        assignment: [{ kind: "fixed", user_id: who.userId }],
      });
      expect(res.status).toBe(403);
    }
    const bad = await h.call(owner, "POST", "/apps/ci/agents", { name: "A" });
    expect(bad.body.code).toBe("INVALID_REQUEST");
  });
});

describe("contract reviews", () => {
  it("go through the queue to a status, a summary, an assignee and a notification", async () => {
    const h = harness();
    const owner = await h.workspace();
    const ana = await h.member(owner);
    const playbookId = await h.playbook(owner, [ana]);
    const { versionId } = await h.contract(owner, [ana]);
    const agentId = await h.agent(owner, playbookId, {
      assignment: [{ kind: "fixed", user_id: ana.userId }],
    });
    h.state.verdicts = { "Liability cap": "not_acceptable" };

    const id = await h.submit(owner, agentId, versionId, { counterparty: "Globex" });
    expect(await h.get(owner, id)).toMatchObject({
      status: "queued",
      playbook_review_id: null,
      source: { kind: "manual" },
    });

    const [done] = await h.settle(owner, id);
    expect(done).toMatchObject({
      status: "deviates",
      result: "deviates",
      assignee_id: ana.userId,
      counterparty: "Globex",
      agent_name: "MSA intake",
      document_name: "msa.docx",
      failure: null,
    });
    expect(done.summary).toContain("Liability cap");
    expect(done.run_id).toBeTruthy();

    expect(await notificationsFor(ana.userId)).toEqual([
      {
        kind: "ci.review_assigned",
        action_required: true,
        url: `#/ci/reviews/${id}`,
        title: expect.stringContaining("MSA intake"),
      },
    ]);
    // The assignee sees it, with the playbook review behind it.
    expect((await h.get(ana, id)).status).toBe("deviates");
    expect((await h.call(ana, "GET", `/reviews/${done.playbook_review_id}`)).status).toBe(200);
    const trail = (await auditTrail(pool, owner.workspaceId)).map((e) => e.action);
    expect(trail).toEqual(
      expect.arrayContaining(["ci.review.queued", "ci.review.finished", "ci.review.assigned"]),
    );

    // Nothing more happens on later ticks.
    await h.ci.tick(owner.workspaceId);
    expect(await notificationsFor(ana.userId)).toHaveLength(1);
  });

  it("are filtered and paged, newest change first", async () => {
    const h = harness({ ci: { pageSize: 2 } });
    const owner = await h.workspace();
    const playbookId = await h.playbook(owner);
    const { versionId } = await h.contract(owner);
    const agentId = await h.agent(owner, playbookId);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await h.submit(owner, agentId, versionId);
      await h.settle(owner, id);
      ids.push(id);
    }
    const first = await h.call(owner, "GET", "/apps/ci/reviews");
    expect(first.body.reviews.map((r: Json) => r.id)).toEqual([ids[2], ids[1]]);
    const next = await h.call(
      owner,
      "GET",
      `/apps/ci/reviews?cursor=${encodeURIComponent(first.body.next_cursor)}`,
    );
    expect(next.body.reviews.map((r: Json) => r.id)).toEqual([ids[0]]);
    expect(next.body.next_cursor).toBeNull();

    const count = async (query: string) =>
      (await h.call(owner, "GET", `/apps/ci/reviews?${query}`)).body.reviews.length;
    expect(await count("filter[status]=aligned")).toBe(2);
    expect(await count("filter[status]=deviates")).toBe(0);
    expect(await count("filter[assignee_id]=me")).toBe(2);
    expect(await count(`filter[agent_id]=${randomUUID()}`)).toBe(0);
    expect((await h.call(owner, "GET", "/apps/ci/reviews?filter[status]=nope")).status).toBe(400);
    expect((await h.call(owner, "GET", "/apps/ci/reviews?cursor=nope")).status).toBe(400);
  });

  it("are only queued by a live agent's owner for a contract they can read", async () => {
    const h = harness();
    const owner = await h.workspace();
    const other = await h.member(owner, [
      "threads.use",
      "agents.build",
      "playbooks.create",
      "vaults.create",
    ]);
    const playbookId = await h.playbook(owner);
    const { versionId } = await h.contract(owner);
    const theirs = await h.contract(other);
    const agentId = await h.agent(owner, playbookId);
    const post = (who: Person, version: string) =>
      h.call(who, "POST", "/apps/ci/reviews", {
        agent_id: agentId,
        document_version_id: version,
      });
    expect((await post(other, theirs.versionId)).status).toBe(404);
    expect((await post(owner, theirs.versionId)).status).toBe(404);
    await h.call(owner, "POST", `/apps/ci/agents/${agentId}/deactivate`);
    expect((await post(owner, versionId)).body.code).toBe("AGENT_NOT_LIVE");
  });

  it("never take a file from the intake inbox", async () => {
    const h = harness();
    const owner = await h.workspace();
    const playbookId = await h.playbook(owner);
    const agentId = await h.agent(owner, playbookId);
    const me = { sessionId: "t", userId: owner.userId, workspaceId: owner.workspaceId };
    const intake = createIntake(pool, { documents: h.documents.raw });
    const sent = await intake.upload(
      me,
      { name: "theirs.txt", bytes: new TextEncoder().encode("1. Liability is unlimited.") },
      { ip: null, userAgent: null },
    );
    if (!sent.ok) throw new Error("upload failed");
    await h.documents.worker.drain(owner.workspaceId);
    const { rows } = await pool.query<{ id: string }>(
      "select id from content.document_version where document_id = $1",
      [sent.value.document_id],
    );
    const versionId = rows[0]?.id;
    const queued = await h.call(owner, "POST", "/apps/ci/reviews", {
      agent_id: agentId,
      document_version_id: versionId,
    });
    expect(queued.status).toBe(404);
    const reviewed = await h.call(owner, "POST", `/playbooks/${playbookId}/reviews`, {
      document_version_id: versionId,
      party: "Acme",
      paper: "theirs",
      surface: "web",
    });
    expect(reviewed.status).toBe(404);
  });

  it("wait while their agent is paused", async () => {
    const h = harness();
    const owner = await h.workspace();
    const agentId = await h.agent(owner, await h.playbook(owner));
    const id = await h.submit(owner, agentId, (await h.contract(owner)).versionId);
    await h.call(owner, "POST", `/apps/ci/agents/${agentId}/deactivate`);
    await h.ci.tick(owner.workspaceId);
    expect((await h.get(owner, id)).status).toBe("queued");
    await h.call(owner, "POST", `/apps/ci/agents/${agentId}/activate`);
    expect((await h.settle(owner, id))[0].status).toBe("aligned");
  });

  it("wait their turn at the per-person review cap, and are not dropped", async () => {
    const h = harness({ maxActive: 1 });
    const owner = await h.workspace();
    const agentId = await h.agent(owner, await h.playbook(owner));
    const { versionId } = await h.contract(owner);
    const release = h.hold();
    const a = await h.submit(owner, agentId, versionId);
    const b = await h.submit(owner, agentId, versionId);
    await h.ci.tick(owner.workspaceId);
    await h.ci.tick(owner.workspaceId);
    const states = [(await h.get(owner, a)).status, (await h.get(owner, b)).status].sort();
    expect(states).toEqual(["queued", "running"]);
    release();
    const done = await h.settle(owner, a, b);
    expect(done.map((r: Json) => r.status)).toEqual(["aligned", "aligned"]);
  });

  it("fail with the reason, and run again when asked", async () => {
    const h = harness();
    const owner = await h.workspace();
    const agentId = await h.agent(owner, await h.playbook(owner));
    const id = await h.submit(owner, agentId, (await h.contract(owner)).versionId);
    h.state.verdicts = { crash: "acceptable" };
    const [failed] = await h.settle(owner, id);
    expect(failed).toMatchObject({ status: "failed", failure: "REVIEW_FAILED", result: null });
    expect(
      (await h.call(owner, "POST", `/apps/ci/reviews/${id}/status`, { status: "done" })).status,
    ).toBe(409);

    h.state.verdicts = { "Term length": "needs_review" };
    const again = await h.call(owner, "POST", `/apps/ci/reviews/${id}/rerun`);
    expect(again.status).toBe(202);
    expect((await h.get(owner, id)).status).toBe("queued");
    expect((await h.call(owner, "POST", `/apps/ci/reviews/${id}/rerun`)).status).toBe(409);
    const [done] = await h.settle(owner, id);
    expect(done).toMatchObject({ status: "needs_review", failure: null });
  });

  it("run as the owner, and fail once the owner loses the means", async () => {
    const h = harness();
    const admin = await h.workspace();
    const owner = await h.member(admin, [
      "threads.use",
      "playbooks.use",
      "playbooks.create",
      "agents.build",
      "vaults.create",
    ]);
    const playbookId = await h.playbook(admin, [owner]);
    const agentId = await h.agent(owner, playbookId);
    const { versionId, documentId } = await h.contract(owner);

    const first = await h.submit(owner, agentId, versionId);
    await pool.query(
      `update core.role set permissions = '{threads.use,playbooks.use}'
        where id = (select role_id from core."user" where id = $1)`,
      [owner.userId],
    );
    await h.ci.tick(owner.workspaceId);
    expect(await h.get(owner, first)).toMatchObject({ status: "failed", failure: "FORBIDDEN" });
    const runs = await pool.query("select 1 from work.run where owner_id = $1", [owner.userId]);
    expect(runs.rowCount).toBe(0);

    await pool.query(
      `update core.role set permissions = '{*}'
        where id = (select role_id from core."user" where id = $1)`,
      [owner.userId],
    );
    const second = await h.submit(owner, agentId, versionId);
    await wallOff(owner, owner.userId, documentId);
    await h.ci.tick(owner.workspaceId);
    const { rows } = await pool.query(
      "select status, failure from apps.ci_contract_review where id = $1",
      [second],
    );
    expect(rows).toEqual([{ status: "failed", failure: "ACCESS_LOST" }]);
  });

  it("go with their document when it is purged", async () => {
    const h = harness();
    const owner = await h.workspace();
    const agentId = await h.agent(owner, await h.playbook(owner));
    const { versionId, documentId } = await h.contract(owner);
    const id = await h.submit(owner, agentId, versionId);
    await h.settle(owner, id);
    await pool.query("delete from content.document where id = $1", [documentId]);
    const { rowCount } = await pool.query("select 1 from apps.ci_contract_review where id = $1", [
      id,
    ]);
    expect(rowCount).toBe(0);
  });
});

describe("the queue screens", () => {
  it("counts what was reviewed since a time, what is ready and what is the caller's", async () => {
    const h = harness();
    const owner = await h.workspace();
    const ana = await h.member(owner);
    const playbookId = await h.playbook(owner, [ana]);
    const { versionId } = await h.contract(owner, [ana]);
    const agentId = await h.agent(owner, playbookId, {
      assignment: [{ kind: "fixed", user_id: ana.userId }],
    });
    const dashboard = async (who: Person, query = "") =>
      (await h.call(who, "GET", `/apps/ci/dashboard${query}`)).body;
    const before = new Date(Date.now() - 60_000).toISOString();

    const first = await h.submit(owner, agentId, versionId);
    const second = await h.submit(owner, agentId, versionId);
    expect(await dashboard(ana, `?since=${before}`)).toMatchObject({
      since_last_visit: 0,
      ready_to_review: 0,
      assigned_to_me: 0,
    });
    await h.settle(owner, first, second);

    const seen = await dashboard(ana, `?since=${before}`);
    expect(seen).toMatchObject({ since_last_visit: 2, ready_to_review: 2, assigned_to_me: 2 });
    expect(await dashboard(owner)).toMatchObject({
      since_last_visit: 0,
      ready_to_review: 2,
      assigned_to_me: 0,
    });

    // Marking one done is not a new review, and takes it off both counts.
    await h.call(ana, "POST", `/apps/ci/reviews/${first}/status`, { status: "done" });
    expect(await dashboard(ana, `?since=${seen.as_of}`)).toMatchObject({
      since_last_visit: 0,
      ready_to_review: 1,
      assigned_to_me: 1,
    });
    const bad = await h.call(ana, "GET", "/apps/ci/dashboard?since=yesterday");
    expect(bad.status).toBe(400);
  });

  it("filters the queue by counterparty and by when it last changed", async () => {
    const h = harness();
    const owner = await h.workspace();
    const playbookId = await h.playbook(owner);
    const { versionId } = await h.contract(owner);
    const agentId = await h.agent(owner, playbookId);
    const globex = await h.submit(owner, agentId, versionId, { counterparty: "Globex Ltd" });
    await h.submit(owner, agentId, versionId, { counterparty: "Initech_100%" });
    const found = async (query: string) => {
      const res = await h.call(owner, "GET", `/apps/ci/reviews?${query}`);
      expect(res.status).toBe(200);
      return res.body.reviews.map((r: Json) => r.id as string);
    };
    expect(await found("filter[counterparty]=glob")).toEqual([globex]);
    // Wildcard characters are matched as written.
    expect(await found("filter[counterparty]=%25")).toHaveLength(1);
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(await found(`filter[from]=${past}&filter[to]=${future}`)).toHaveLength(2);
    expect(await found(`filter[from]=${future}`)).toEqual([]);
    expect(await found(`filter[to]=${past}`)).toEqual([]);
    expect((await h.call(owner, "GET", "/apps/ci/reviews?filter[from]=soon")).status).toBe(400);
  });

  it("names the people and groups an agent's rules point at", async () => {
    const h = harness();
    const owner = await h.workspace();
    const ana = await h.member(owner);
    const team = await h.group(owner, [ana]);
    const playbookId = await h.playbook(owner);
    const agentId = await h.agent(owner, playbookId, {
      assignment: [
        {
          kind: "field",
          field: "governing_law",
          cases: [{ op: "eq", value: "DE", assignee: { user_id: ana.userId } }],
        },
        { kind: "round_robin", group_id: team },
      ],
    });
    const res = await h.call(owner, "GET", `/apps/ci/agents/${agentId}`);
    expect(res.body.names[ana.userId]).toBe(ana.email);
    expect(res.body.names[team]).toMatch(/^g-/);
  });
});

describe("assignment", () => {
  it("takes turns through a group, skipping those who can't open the contract", async () => {
    const h = harness();
    const owner = await h.workspace();
    const [ana, ben, cut] = [await h.member(owner), await h.member(owner), await h.member(owner)];
    const playbookId = await h.playbook(owner, [ana, ben, cut]);
    // `cut` is in the group but can't read the vault.
    const { versionId } = await h.contract(owner, [ana, ben]);
    const groupId = await h.group(owner, [ana, ben, cut]);
    const agentId = await h.agent(owner, playbookId, {
      assignment: [{ kind: "round_robin", group_id: groupId }],
    });
    const ids = [
      await h.submit(owner, agentId, versionId),
      await h.submit(owner, agentId, versionId),
      await h.submit(owner, agentId, versionId),
      await h.submit(owner, agentId, versionId),
    ];
    // Two queues at once, as two servers would be.
    for (let i = 0; i < 200; i++) {
      await Promise.all([h.ci.tick(owner.workspaceId), h.ci.tick(owner.workspaceId)]);
      const found = await Promise.all(ids.map((id) => h.get(owner, id)));
      if (found.every((r) => r.status === "aligned")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const given = await Promise.all(ids.map(async (id) => (await h.get(owner, id)).assignee_id));
    expect(given.filter((a) => a === ana.userId)).toHaveLength(2);
    expect(given.filter((a) => a === ben.userId)).toHaveLength(2);
    expect(await notificationsFor(cut.userId)).toEqual([]);
  });

  it("matches fields, and falls back to the owner when nobody can open the contract", async () => {
    const h = harness();
    const owner = await h.workspace();
    const [eu, outsider] = [await h.member(owner), await h.member(owner)];
    const playbookId = await h.playbook(owner, [eu, outsider]);
    const { versionId } = await h.contract(owner, [eu]);
    const agentId = await h.agent(owner, playbookId, {
      assignment: [
        {
          kind: "field",
          field: "governing_law",
          cases: [
            { op: "in", value: ["DE", "FR"], assignee: { user_id: eu.userId } },
            { op: "eq", value: "US", assignee: { user_id: outsider.userId } },
          ],
        },
      ],
    });
    const german = await h.submit(owner, agentId, versionId, { fields: { governing_law: "DE" } });
    const american = await h.submit(owner, agentId, versionId, { fields: { governing_law: "US" } });
    const [a, b] = await h.settle(owner, german, american);
    expect(a.assignee_id).toBe(eu.userId);
    expect(b.assignee_id).toBe(owner.userId);
  });

  it("can be handed on and marked done by the assignee, not rerun", async () => {
    const h = harness();
    const owner = await h.workspace();
    const [ana, ben, noAccess] = [
      await h.member(owner),
      await h.member(owner),
      await h.member(owner),
    ];
    const playbookId = await h.playbook(owner, [ana, ben]);
    const { versionId } = await h.contract(owner, [ana, ben, noAccess]);
    const agentId = await h.agent(owner, playbookId, {
      assignment: [{ kind: "fixed", user_id: ana.userId }],
    });
    const id = await h.submit(owner, agentId, versionId);
    await h.settle(owner, id);
    const assign = (who: Person, to: Person) =>
      h.call(who, "POST", `/apps/ci/reviews/${id}/assign`, { assignee_id: to.userId });

    // Someone who can read the contract but not the playbook couldn't open the review.
    expect((await assign(ana, noAccess)).body.code).toBe("ASSIGNEE_NOT_ALLOWED");
    expect((await h.call(ana, "POST", `/apps/ci/reviews/${id}/rerun`)).status).toBe(403);
    expect((await h.call(ben, "GET", `/apps/ci/reviews/${id}`)).status).toBe(404);
    const handed = await assign(ana, ben);
    expect(handed.status).toBe(200);
    expect(handed.body.review.assignee_id).toBe(ben.userId);
    expect(await notificationsFor(ben.userId)).toHaveLength(1);
    // Ana handed it on: she still sees it, but it isn't hers to act on.
    expect((await assign(ana, ana)).status).toBe(403);
    expect(
      (await h.call(ana, "POST", `/apps/ci/reviews/${id}/status`, { status: "done" })).status,
    ).toBe(403);

    const done = await h.call(ben, "POST", `/apps/ci/reviews/${id}/status`, { status: "done" });
    expect(done.body.review).toMatchObject({ status: "done", result: "aligned" });
    expect(done.body.review.done_at).toBeTruthy();
    expect((await assign(owner, ana)).body.code).toBe("WRONG_STATE");
    const { rows } = await pool.query(
      `select 1 from analytics.outcome_event
        where workspace_id = $1 and workflow_type = 'contract_reviewed'`,
      [owner.workspaceId],
    );
    expect(rows).toHaveLength(1);
  });

  it("hides a walled matter's contract from the queue and from its assignee", async () => {
    const h = harness();
    const owner = await h.workspace();
    const ana = await h.member(owner);
    const playbookId = await h.playbook(owner, [ana]);
    const { versionId, documentId } = await h.contract(owner, [ana]);
    const agentId = await h.agent(owner, playbookId, {
      assignment: [{ kind: "fixed", user_id: ana.userId }],
    });
    const id = await h.submit(owner, agentId, versionId);
    await h.settle(owner, id);
    expect((await h.call(ana, "GET", "/apps/ci/reviews")).body.reviews).toHaveLength(1);

    await wallOff(owner, ana.userId, documentId);

    expect((await h.call(ana, "GET", "/apps/ci/reviews")).body.reviews).toEqual([]);
    expect((await h.call(ana, "GET", `/apps/ci/reviews/${id}`)).status).toBe(404);
    expect(
      (await h.call(ana, "POST", `/apps/ci/reviews/${id}/status`, { status: "done" })).status,
    ).toBe(404);
    // And a walled person can't be given it.
    expect(
      (await h.call(owner, "POST", `/apps/ci/reviews/${id}/assign`, { assignee_id: ana.userId }))
        .body.code,
    ).toBe("ASSIGNEE_NOT_ALLOWED");
  });
});

/** One finished review, owned by a workspace admin and assigned to `ana`. */
async function assigned(h: ReturnType<typeof harness>) {
  const owner = await h.workspace();
  const [ana, ben] = [await h.member(owner), await h.member(owner)];
  const playbookId = await h.playbook(owner, [ana, ben]);
  const { versionId } = await h.contract(owner, [ana, ben]);
  const agentId = await h.agent(owner, playbookId, {
    assignment: [{ kind: "fixed", user_id: ana.userId }],
  });
  h.state.verdicts = { "Liability cap": "not_acceptable" };
  const id = await h.submit(owner, agentId, versionId);
  await h.settle(owner, id);
  return { owner, ana, ben, playbookId, versionId, agentId, id };
}

const as = (who: Person, sql: string, params: unknown[]) =>
  asApp(pool, { userId: who.userId, workspaceId: who.workspaceId }, (db) => db.query(sql, params));

const reviewsOf = async (workspaceId: string) =>
  (await pool.query("select 1 from work.playbook_review where workspace_id = $1", [workspaceId]))
    .rowCount;

describe("what a participant can see and change", () => {
  it("hides the summary from someone who can't open the playbook", async () => {
    const h = harness();
    const { owner, ana, ben, playbookId, id } = await assigned(h);
    expect((await h.get(ana, id)).summary).toContain("Liability cap");
    const narrowed = await h.call(owner, "PUT", `/playbooks/${playbookId}/grants`, [
      { principal_type: "user", principal_id: ben.userId, level: "view" },
    ]);
    expect(narrowed.status).toBe(200);
    expect(await h.get(ana, id)).toMatchObject({ status: "deviates", summary: null });
    const listed = await h.call(ana, "GET", "/apps/ci/reviews");
    expect(listed.body.reviews[0].summary).toBeNull();
    expect((await h.get(owner, id)).summary).toContain("Liability cap");
  });

  it("ends the previous holder's sight of a review when it is rerun", async () => {
    const h = harness();
    const { owner, ana, ben, id } = await assigned(h);
    await h.call(ana, "POST", `/apps/ci/reviews/${id}/assign`, { assignee_id: ben.userId });
    expect((await h.call(ana, "GET", `/apps/ci/reviews/${id}`)).status).toBe(200);
    expect((await h.call(owner, "POST", `/apps/ci/reviews/${id}/rerun`)).status).toBe(202);
    expect((await h.call(ana, "GET", `/apps/ci/reviews/${id}`)).status).toBe(404);
  });

  it("lets the database refuse anything but handing on and finishing", async () => {
    const h = harness();
    const { ana, ben, id } = await assigned(h);
    for (const change of [
      "status = 'aligned'",
      "status = 'queued'",
      "result = 'aligned'",
      "summary = 'Fine.'",
      "failure = 'X'",
      "next_attempt_at = now()",
      "playbook_review_id = null",
      "playbook_id = core.uuid7()",
      `assigned_by = '${ben.userId}'`,
      `assignee_id = '${ben.userId}'`,
      "done_at = now()",
    ]) {
      await expect(
        as(ana, `update apps.ci_contract_review set ${change} where id = $1`, [id]),
        change,
      ).rejects.toMatchObject({ code: "42501" });
    }
    const handed = await as(
      ana,
      `update apps.ci_contract_review set assignee_id = $2, assigned_by = $3 where id = $1`,
      [id, ben.userId, ana.userId],
    );
    expect(handed.rowCount).toBe(1);
    // Having handed it on, Ana can read it and no more.
    const late = await as(ana, "update apps.ci_contract_review set status = 'done' where id = $1", [
      id,
    ]);
    expect(late.rowCount).toBe(0);
    const done = await as(
      ben,
      "update apps.ci_contract_review set status = 'done', done_at = now() where id = $1",
      [id],
    );
    expect(done.rowCount).toBe(1);
  });

  it("lets the database queue a review only in its starting state", async () => {
    const h = harness();
    const { owner, id } = await assigned(h);
    for (const [column, value] of [
      ["status", "'aligned'"],
      ["result", "'aligned'"],
      ["summary", "'Fine.'"],
      ["assignee_id", "owner_id"],
    ]) {
      await expect(
        as(
          owner,
          `insert into apps.ci_contract_review (workspace_id, ci_agent_id, agent_name, owner_id,
             playbook_id, document_id, document_version_id, ${column})
           select workspace_id, ci_agent_id, agent_name, owner_id, playbook_id, document_id,
                  document_version_id, ${value}
             from apps.ci_contract_review where id = $1`,
          [id],
        ),
        column,
      ).rejects.toMatchObject({ code: "42501" });
    }
  });
});

describe("races and records", () => {
  it("keeps an assignee set by hand while the review was finishing", async () => {
    const h = harness();
    const owner = await h.workspace();
    const [ana, ben] = [await h.member(owner), await h.member(owner)];
    const playbookId = await h.playbook(owner, [ana, ben]);
    const { versionId } = await h.contract(owner, [ana, ben]);
    const agentId = await h.agent(owner, playbookId, {
      assignment: [{ kind: "fixed", user_id: ana.userId }],
    });
    const id = await h.submit(owner, agentId, versionId);
    let once = false;
    h.state.onGet = async () => {
      const { rows } = await pool.query(
        `select 1 from apps.ci_contract_review r
           join work.playbook_review p on p.id = r.playbook_review_id
          where r.id = $1 and p.status = 'done'`,
        [id],
      );
      if (once || rows.length === 0) return;
      once = true;
      const res = await h.call(owner, "POST", `/apps/ci/reviews/${id}/assign`, {
        assignee_id: ben.userId,
      });
      expect(res.status).toBe(200);
    };
    // The first look may come before the engine is done; the hook waits for a finished one.
    const [done] = await h.settle(owner, id);
    expect(once).toBe(true);
    expect(done).toMatchObject({ status: "aligned", assignee_id: ben.userId });
  });

  it("checks again who may act, in the transaction that writes", async () => {
    const h = harness();
    const { owner, ana, ben, id } = await assigned(h);
    for (const [path, body] of [
      ["assign", { assignee_id: owner.userId }],
      ["status", { status: "done" }],
    ] as const) {
      await pool.query("update apps.ci_contract_review set assignee_id = $2 where id = $1", [
        id,
        ana.userId,
      ]);
      const taking = await pool.connect();
      try {
        await taking.query("begin");
        await taking.query("update apps.ci_contract_review set assignee_id = $2 where id = $1", [
          id,
          ben.userId,
        ]);
        const acting = h.call(ana, "POST", `/apps/ci/reviews/${id}/${path}`, body);
        await new Promise((r) => setTimeout(r, 300));
        await taking.query("commit");
        expect([403, 404], path).toContain((await acting).status);
      } finally {
        taking.release();
      }
    }
  });

  it("starts one paid review even if the queue dies right after starting it", async () => {
    const h = harness();
    const owner = await h.workspace();
    const agentId = await h.agent(owner, await h.playbook(owner));
    const id = await h.submit(owner, agentId, (await h.contract(owner)).versionId);
    let crashed = false;
    h.state.onStarted = () => {
      if (crashed) return;
      crashed = true;
      throw new Error("the server stopped");
    };
    // The lease has run out by the next tick, as it would after a restart.
    await h.ci.tick(owner.workspaceId);
    await pool.query("update apps.ci_contract_review set next_attempt_at = now() where id = $1", [
      id,
    ]);
    const [done] = await h.settle(owner, id);
    expect(done.status).toBe("aligned");
    expect(await reviewsOf(owner.workspaceId)).toBe(1);
  });

  it("starts one paid review when two queues take the same contract", async () => {
    const h = harness({ ci: { leaseSeconds: 0 } });
    const owner = await h.workspace();
    const agentId = await h.agent(owner, await h.playbook(owner));
    const { versionId } = await h.contract(owner);
    const ids = [
      await h.submit(owner, agentId, versionId),
      await h.submit(owner, agentId, versionId),
    ];
    await Promise.all([1, 2, 3].map(() => h.ci.tick(owner.workspaceId)));
    await h.settle(owner, ...ids);
    expect(await reviewsOf(owner.workspaceId)).toBe(2);
  });

  it("audits a review failed because its owner can no longer see it", async () => {
    const h = harness();
    const owner = await h.workspace();
    const agentId = await h.agent(owner, await h.playbook(owner));
    const { versionId, documentId } = await h.contract(owner);
    const id = await h.submit(owner, agentId, versionId);
    await wallOff(owner, owner.userId, documentId);
    await h.ci.tick(owner.workspaceId);
    await h.ci.tick(owner.workspaceId);
    const events = (await auditTrail(pool, owner.workspaceId)).filter(
      (e) => e.action === "ci.review.finished" && e.object_id === id,
    );
    expect(events).toMatchObject([{ actor_type: "system", details: { failure: "ACCESS_LOST" } }]);
  });
});
