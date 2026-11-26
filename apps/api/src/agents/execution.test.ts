import { randomUUID } from "node:crypto";
import { createGateway, type Message, type ModelProvider } from "@legallabs/model-gateway";
import { createLocalEngine } from "@legallabs/runs";
import { afterAll, describe, expect, it } from "vitest";
import { runAudit } from "../agent-runs/audit.js";
import { runHandlers } from "../agent-runs/handlers.js";
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
import { createContextPort } from "./context.js";
import { createNudges } from "./nudges.js";
import { createAgentHandler, type ModelPolicy } from "./run-handler.js";
import { createScheduleFirer } from "./schedule-fire.js";

const pool = testPool();
afterAll(() => pool.end());
const V7 = "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d4f";
const BUILDER = ["agents.use", "agents.build", "threads.use"];
const USER = ["agents.use", "threads.use"];

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

// A scripted model: replies come off a queue, and every prompt is kept for the test to read.
function scripted(replies: string[]) {
  const prompts: Message[][] = [];
  const queue = [...replies];
  const provider: ModelProvider = {
    complete: async ({ messages }) => {
      prompts.push([...messages]);
      return { text: queue.shift() ?? "Done.", usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
  return { provider, prompts, queue };
}

function harness(replies: string[], policy?: ModelPolicy) {
  const model = scripted(replies);
  const gateway = createGateway({
    providers: { ollama: model.provider },
    recordUsage: async () => {},
  });
  const documents = testDocuments(pool);
  const context = createContextPort(pool);
  const agents = createAgents(pool, { attachments: context, documents });
  const handlers = runHandlers(pool, { gateway, agents });
  if (policy) handlers.agent = createAgentHandler({ pool, gateway, context, policy });
  const engine = createLocalEngine({ pool, handlers, audit: runAudit(pool) });
  const runs = createAgentRuns(pool, { engine });
  const nudges = createNudges(pool);
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: testThreads(pool, documents),
    drafts: createDrafts(pool, { gateway, templates: createTemplatePort(pool) }),
    agentRuns: runs,
    agents,
    agentNudges: nudges,
    clientIp: () => "203.0.113.9",
  });
  const cookies = new Map<string, string>();
  const call = async (who: Seeded, method: string, path: string, json?: unknown) => {
    let cookie = cookies.get(who.email);
    if (!cookie) {
      const res = await app.request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: who.slug, email: who.email, password: PASSWORD }),
      });
      cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      cookies.set(who.email, cookie);
    }
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const principal = (m: Seeded) => ({ sessionId: randomUUID(), ...m });
  return { ...model, gateway, documents, agents, engine, runs, nudges, call, principal };
}
type H = ReturnType<typeof harness>;

async function liveAgent(
  h: H,
  who: Seeded,
  instructions = "Summarise the NDA.",
  attachments: object[] = [],
) {
  const id = (await h.call(who, "POST", "/agents", { title: "NDA review", mode: "scratch" })).body
    .agent.id as string;
  const saved = await h.call(who, "POST", `/agents/${id}/versions`, {
    instructions,
    attachments,
    promote: true,
  });
  expect(saved.status).toBe(201);
  return id;
}
const finish = async (h: H, runId: string) => h.engine.result(runId);
const events = async (runId: string) =>
  (
    await pool.query<{ type: string; data: Record<string, unknown> }>(
      "select type, data from work.run_event where run_id = $1 order by seq",
      [runId],
    )
  ).rows;
const runRow = async (runId: string) =>
  (
    await pool.query(
      "select status, error_code, cost_usd::float8 cost, answer_id, thread_id from work.run where id = $1",
      [runId],
    )
  ).rows[0];
const until = async (runId: string, want: string) => {
  for (let i = 0; i < 150 && (await runRow(runId)).status !== want; i += 1)
    await new Promise((r) => setTimeout(r, 20));
};

describe("running an agent", () => {
  it("answers in the thread from the instructions and the attached file, and sums step cost", async () => {
    const h = harness(["The NDA lasts two years."]);
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const doc = await h.documents.upload(
      h.principal(bea),
      {
        name: "nda.txt",
        bytes: new TextEncoder().encode("This NDA lasts two years from signing."),
        matterId: null,
      },
      { ip: null, userAgent: null },
    );
    if (!doc.ok) throw new Error(doc.reason);
    const id = await liveAgent(h, bea, "Summarise @nda for the client.", [
      { label: "nda", kind: "upload", ref: doc.document.id, name: "nda.txt" },
    ]);

    const started = await h.call(bea, "POST", `/agents/${id}/run`, { inputs: "keep it short" });
    expect(started.status).toBe(202);
    expect(await finish(h, started.body.run_id)).toEqual({ status: "done" });

    const prompt = (h.prompts[0] ?? []).map((m) => m.content).join("\n");
    expect(prompt).toContain("Summarise @nda for the client.");
    expect(prompt).toContain("This NDA lasts two years from signing.");
    expect(prompt).toContain("keep it short");
    const reply = (
      await pool.query(
        "select id, content, role from work.message where thread_id = $1 order by id",
        [started.body.thread_id],
      )
    ).rows;
    // A random (v4) id sorts before the question now and then; every message id is time-ordered.
    expect(reply.map((r) => r.id.charAt(14))).toEqual(["7", "7"]);
    expect(reply.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(reply[1].content).toBe("The NDA lasts two years.");

    const steps = (await h.call(bea, "GET", `/runs/${started.body.run_id}/steps`)).body.steps;
    expect(steps.map((s: { kind: string }) => s.kind)).toEqual(["retrieve", "generate"]);
    const run = await runRow(started.body.run_id);
    expect(run.cost).toBeCloseTo(
      steps.reduce((n: number, s: { cost_usd: number }) => n + s.cost_usd, 0),
      6,
    );
    const types = (await events(started.body.run_id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["plan", "coverage", "token", "output", "done"]));
    expect((await auditTrail(pool, bea.workspaceId)).map((e) => e.action)).toEqual(
      expect.arrayContaining(["agent.run.started", "agent.run.finished"]),
    );
  });

  it("lets someone with only Run access use the agent's uploaded file", async () => {
    const h = harness(["Fine."]);
    const p = await workspace({ bea: BUILDER, rae: USER });
    const bea = p.bea as Seeded;
    const rae = p.rae as Seeded;
    const doc = await h.documents.upload(
      h.principal(bea),
      {
        name: "p.txt",
        bytes: new TextEncoder().encode("Playbook says: cap liability."),
        matterId: null,
      },
      { ip: null, userAgent: null },
    );
    if (!doc.ok) throw new Error(doc.reason);
    const id = await liveAgent(h, bea, "Use @pb.", [
      { label: "pb", kind: "upload", ref: doc.document.id, name: "p.txt" },
    ]);
    await h.call(bea, "POST", `/agents/${id}/shares`, {
      principal_type: "user",
      principal_id: rae.userId,
      level: "run",
    });
    const started = await h.call(rae, "POST", `/agents/${id}/run`, { inputs: "go" });
    expect(await finish(h, started.body.run_id)).toEqual({ status: "done" });
    expect((h.prompts[0] ?? []).map((m) => m.content).join("\n")).toContain("cap liability");
    // The runner never sees the instructions, only what the run says.
    expect((await h.call(rae, "GET", `/agents/${id}/versions`)).body.versions).toEqual([]);
  });

  it("leaves out an attachment the runner can't reach, without naming it, and runs on", async () => {
    const h = harness(["Done with what I could read."]);
    const p = await workspace({ bea: BUILDER, rae: USER });
    const bea = p.bea as Seeded;
    const rae = p.rae as Seeded;
    const doc = await h.documents.upload(
      h.principal(bea),
      { name: "a.txt", bytes: new TextEncoder().encode("Readable text."), matterId: null },
      { ip: null, userAgent: null },
    );
    if (!doc.ok) throw new Error(doc.reason);
    const vault = (
      await pool.query<{ id: string }>(
        "insert into content.vault (workspace_id, owner_id, name) values ($1, $2, 'Secret vault') returning id",
        [bea.workspaceId, bea.userId],
      )
    ).rows[0]?.id;
    const id = await liveAgent(h, bea, "Use what you have.", [
      { label: "ok", kind: "upload", ref: doc.document.id, name: "a.txt" },
      { label: "hidden", kind: "vault", ref: vault, name: "Secret vault" },
    ]);
    await h.call(bea, "POST", `/agents/${id}/shares`, {
      principal_type: "user",
      principal_id: rae.userId,
      level: "run",
    });
    const started = await h.call(rae, "POST", `/agents/${id}/run`, {});
    expect(await finish(h, started.body.run_id)).toEqual({ status: "done" });
    const prompt = (h.prompts[0] ?? []).map((m) => m.content).join("\n");
    expect(prompt).toContain("Readable text.");
    expect(prompt).not.toContain("Secret vault");
    const plan = (
      await pool.query("select plan from work.run where id = $1", [started.body.run_id])
    ).rows[0].plan;
    expect(plan.left_out).toEqual(["hidden"]);
    expect(JSON.stringify(plan.not_read)).not.toContain("Secret vault");
  });

  it("fails with WALL_NO_ACCESSIBLE_CONTEXT when every attachment is out of reach", async () => {
    const h = harness(["never"]);
    const p = await workspace({ bea: BUILDER, rae: USER });
    const bea = p.bea as Seeded;
    const rae = p.rae as Seeded;
    const vault = (
      await pool.query<{ id: string }>(
        "insert into content.vault (workspace_id, owner_id, name) values ($1, $2, 'Secret vault') returning id",
        [bea.workspaceId, bea.userId],
      )
    ).rows[0]?.id;
    const id = await liveAgent(h, bea, "Use the vault.", [
      { label: "hidden", kind: "vault", ref: vault, name: "Secret vault" },
    ]);
    await h.call(bea, "POST", `/agents/${id}/shares`, {
      principal_type: "user",
      principal_id: rae.userId,
      level: "run",
    });
    const started = await h.call(rae, "POST", `/agents/${id}/run`, {});
    expect(await finish(h, started.body.run_id)).toEqual({
      status: "failed",
      code: "WALL_NO_ACCESSIBLE_CONTEXT",
    });
    expect(h.prompts).toHaveLength(0);
    const err = (await events(started.body.run_id)).find((e) => e.type === "error");
    expect(JSON.stringify(err)).not.toContain("Secret vault");
  });

  it("fails fast with MODEL_POLICY_NO_ELIGIBLE_MODEL, before any step", async () => {
    const h = harness(["never"], { eligible: async (_w, _m, cls) => cls !== "draft" });
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = await liveAgent(h, bea);
    const started = await h.call(bea, "POST", `/agents/${id}/run`, {});
    expect(await finish(h, started.body.run_id)).toEqual({
      status: "failed",
      code: "MODEL_POLICY_NO_ELIGIBLE_MODEL",
    });
    expect(h.prompts).toHaveLength(0);
    expect(
      (
        await pool.query("select count(*)::int n from work.run_step where run_id = $1", [
          started.body.run_id,
        ])
      ).rows[0].n,
    ).toBe(0);
    const err = (await events(started.body.run_id)).find((e) => e.type === "error");
    expect(err?.data.message).toContain("draft");
  });

  it("asks a question, waits, and carries the answer into the next call", async () => {
    const h = harness([
      'ASK: {"question":"Which party are you?","options":[{"id":"buyer","label":"Buyer"}],"allow_text":true}',
      "Reviewed as the buyer.",
    ]);
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = await liveAgent(h, bea);
    const started = await h.call(bea, "POST", `/agents/${id}/run`, {});
    await until(started.body.run_id, "awaiting_input");
    const asking = (await events(started.body.run_id)).find((e) => e.type === "question");
    expect(asking?.data.question).toMatchObject({ text: "Which party are you?" });
    const signal = await h.call(bea, "POST", `/runs/${started.body.run_id}/signal`, {
      name: "answer_question",
      step_id: asking?.data.step_id,
      answer: { option_id: "buyer" },
    });
    expect(signal.status).toBe(202);
    expect(await finish(h, started.body.run_id)).toEqual({ status: "done" });
    expect((h.prompts[1] ?? []).map((m) => m.content).join("\n")).toContain("A: buyer");
  });

  it("skips the question itself in a scheduled run, and says so", async () => {
    const h = harness(['ASK: {"question":"Which party?"}', "Assumed buyer."]);
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = await liveAgent(h, bea);
    const started = await h.runs.start(h.principal(bea), {
      kind: "agent",
      subject_id: id,
      title: "T",
      path: "schedule",
      interactive: false,
      agent_version_id: (await h.call(bea, "GET", `/agents/${id}`)).body.agent.live_version_id,
    });
    expect(await finish(h, started.run_id)).toEqual({ status: "done" });
    expect((h.prompts[1] ?? []).map((m) => m.content).join("\n")).toContain(
      "(skipped; proceed with reasonable assumptions)",
    );
    const steps = (await h.call(bea, "GET", `/runs/${started.run_id}/steps`)).body.steps;
    expect(steps.map((s: { status: string }) => s.status)).toEqual(["skipped", "done"]);
  });

  it("marks test runs and keeps them out of the agent's run counts", async () => {
    const h = harness(["ok"]);
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = await liveAgent(h, bea);
    const t = await h.call(bea, "POST", `/agents/${id}/test`, { inputs: "try" });
    expect(await finish(h, t.body.run_id)).toEqual({ status: "done" });
    const stats = (await h.call(bea, "GET", `/agents/${id}`)).body.agent.stats;
    expect(stats).toMatchObject({ runs: 0, test_runs: 1 });
  });
});

describe("the builder", () => {
  const ask = (q: string) => `QUESTION: ${JSON.stringify({ question: q, allow_text: true })}`;
  const written = JSON.stringify({
    title: "NDA first pass",
    description: "Reviews inbound NDAs.",
    practice_areas: ["commercial"],
    instructions: "Check the term and governing law of @nda.",
    suggested_attachments: ["NDA playbook"],
  });

  it("asks questions one at a time, then drafts without going live", async () => {
    const h = harness([
      ask("Who sends the NDAs?"),
      ask("What output do you want?"),
      "READY",
      written,
    ]);
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = (await h.call(bea, "POST", "/agents", { mode: "describe" })).body.agent.id;
    const started = await h.call(bea, "POST", `/agents/${id}/builder`, {
      message: "Review inbound NDAs and email me a summary",
    });
    for (const reply of ["Sales", "A table"]) {
      const want = reply === "Sales" ? 1 : 2;
      for (
        let i = 0;
        i < 150 &&
        (await events(started.body.run_id)).filter((e) => e.type === "question").length < want;
        i += 1
      )
        await new Promise((r) => setTimeout(r, 20));
      const q = (await events(started.body.run_id)).filter((e) => e.type === "question")[want - 1];
      await h.call(bea, "POST", `/runs/${started.body.run_id}/signal`, {
        name: "answer_question",
        step_id: q?.data.step_id,
        answer: { text: reply },
      });
    }
    expect(await finish(h, started.body.run_id)).toEqual({ status: "done" });
    const said = await pool.query<{ id: string }>(
      "select id from work.message where thread_id = $1 and role = 'assistant'",
      [started.body.thread_id],
    );
    expect(said.rows.length).toBeGreaterThan(0);
    expect(said.rows.every((m) => m.id.charAt(14) === "7")).toBe(true);

    const agent = (await h.call(bea, "GET", `/agents/${id}`)).body.agent;
    expect(agent).toMatchObject({
      title: "NDA first pass",
      description: "Reviews inbound NDAs.",
      status: "draft",
      live_version_id: null,
    });
    const draft = (await h.call(bea, "GET", `/agents/${id}/versions`)).body.versions.find(
      (v: { id: string }) => v.id === agent.draft_version_id,
    );
    expect(draft.instructions).toBe("Check the term and governing law of @nda.");
    expect((await events(started.body.run_id)).some((e) => e.type === "draft_updated")).toBe(true);
    expect((await events(started.body.run_id)).filter((e) => e.type === "question")).toHaveLength(
      2,
    );
  });

  it("never asks more than five questions", async () => {
    const h = harness([...Array.from({ length: 8 }, (_, i) => ask(`Question ${i}?`)), written]);
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = (await h.call(bea, "POST", "/agents", { mode: "describe" })).body.agent.id;
    const started = await h.call(bea, "POST", `/agents/${id}/builder`, { message: "Do something" });
    for (let n = 1; n <= 5; n += 1) {
      for (
        let i = 0;
        i < 150 &&
        (await events(started.body.run_id)).filter((e) => e.type === "question").length < n;
        i += 1
      )
        await new Promise((r) => setTimeout(r, 20));
      const q = (await events(started.body.run_id)).filter((e) => e.type === "question")[n - 1];
      await h.call(bea, "POST", `/runs/${started.body.run_id}/signal`, {
        name: "answer_question",
        step_id: q?.data.step_id,
        answer: { text: "x" },
      });
    }
    expect(await finish(h, started.body.run_id)).toEqual({ status: "done" });
    expect((await events(started.body.run_id)).filter((e) => e.type === "question")).toHaveLength(
      5,
    );
  });

  it("writes straight away when the person skips the rest", async () => {
    const h = harness([ask("First?"), written]);
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = (await h.call(bea, "POST", "/agents", { mode: "describe" })).body.agent.id;
    const started = await h.call(bea, "POST", `/agents/${id}/builder`, { message: "Do something" });
    for (
      let i = 0;
      i < 150 &&
      (await events(started.body.run_id)).filter((e) => e.type === "question").length < 1;
      i += 1
    )
      await new Promise((r) => setTimeout(r, 20));
    const q = (await events(started.body.run_id)).find((e) => e.type === "question");
    await h.call(bea, "POST", `/runs/${started.body.run_id}/signal`, {
      name: "answer_question",
      step_id: q?.data.step_id,
      answer: { skip: true },
    });
    expect(await finish(h, started.body.run_id)).toEqual({ status: "done" });
    expect((await events(started.body.run_id)).filter((e) => e.type === "question")).toHaveLength(
      1,
    );
  });

  it("keeps a plain-text reply as the draft when the model ignores the format", async () => {
    const h = harness(["READY", "Just do the review carefully."]);
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = (await h.call(bea, "POST", "/agents", { mode: "describe" })).body.agent.id;
    const started = await h.call(bea, "POST", `/agents/${id}/builder`, {
      message: "Review things",
    });
    expect(await finish(h, started.body.run_id)).toEqual({ status: "done" });
    const versions = (await h.call(bea, "GET", `/agents/${id}/versions`)).body.versions;
    expect(versions[0].instructions).toBe("Just do the review carefully.");
  });

  it("proposes changes from the test tab as a new draft, leaving the live version alone", async () => {
    const h = harness(["Review the NDA carefully and list every deadline."]);
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = await liveAgent(h, bea, "Review the NDA.");
    const before = (await h.call(bea, "GET", `/agents/${id}`)).body.agent;
    const r = await h.call(bea, "POST", `/agents/${id}/test/request-changes`, {
      request: "also list every deadline",
    });
    expect(r.status).toBe(202);
    expect(await finish(h, r.body.run_id)).toEqual({ status: "done" });
    const after = (await h.call(bea, "GET", `/agents/${id}`)).body.agent;
    expect(after.live_version_id).toBe(before.live_version_id);
    expect(after.draft_version_id).not.toBeNull();
    const diff = await h.call(
      bea,
      "GET",
      `/agents/${id}/versions/${after.live_version_id}/diff/${after.draft_version_id}`,
    );
    expect(diff.body.instructions_diff.some((o: { op: string }) => o.op === "insert")).toBe(true);
    expect(
      (await events(r.body.run_id)).find((e) => e.type === "draft_updated")?.data,
    ).toMatchObject({ agent_id: id, draft_version_id: after.draft_version_id });
    expect((await h.call(bea, "GET", `/agents/${id}`)).body.agent.stats.test_runs).toBe(0);
  });
});

describe("nudges", () => {
  // Titles and descriptions of shared agents, and prompts with the agent each should (or shouldn't) bring up.
  const agentsSet: [string, string][] = [
    [
      "DPIA screening",
      "Screens a new vendor or project to decide whether a data protection impact assessment is needed",
    ],
    ["NDA first pass", "Reviews inbound non-disclosure agreements against the standard playbook"],
    ["Lease abstract", "Extracts rent, term, break clauses and key dates from a commercial lease"],
    ["Privacy notice check", "Checks a privacy notice against GDPR transparency requirements"],
    ["Board minutes", "Drafts board meeting minutes from notes and resolutions"],
    [
      "Employment contract review",
      "Reviews employment contracts for restrictive covenants and notice periods",
    ],
  ];
  const prompts: [string, string | null][] = [
    ["do I need a DPIA for this vendor?", "DPIA screening"],
    ["is a data protection impact assessment required for the new CRM", "DPIA screening"],
    ["please review this non-disclosure agreement from the supplier", "NDA first pass"],
    ["can you check the NDA we received", "NDA first pass"],
    ["pull the break clauses and rent from this lease", "Lease abstract"],
    ["what are the key dates in the commercial lease", "Lease abstract"],
    ["does our privacy notice meet GDPR transparency", "Privacy notice check"],
    ["draft the minutes for yesterday's board meeting", "Board minutes"],
    ["check the restrictive covenants in this employment contract", "Employment contract review"],
    ["what is the notice period in this employment agreement", "Employment contract review"],
    ["what's the weather like in Sydney", null],
    ["translate this paragraph into French", null],
  ];

  it("suggests the right shared agent, never runs it, and clears the precision gate", async () => {
    const h = harness([]);
    const p = await workspace({ bea: BUILDER, rae: USER });
    const bea = p.bea as Seeded;
    const rae = p.rae as Seeded;
    const ids = new Map<string, string>();
    for (const [title, description] of agentsSet) {
      const id = (await h.call(bea, "POST", "/agents", { title, mode: "scratch" })).body.agent
        .id as string;
      await h.call(bea, "PATCH", `/agents/${id}`, { description, auto_description: false });
      await h.call(bea, "POST", `/agents/${id}/versions`, {
        instructions: "Do it.",
        promote: true,
      });
      await h.call(bea, "POST", `/agents/${id}/shares`, {
        principal_type: "user",
        principal_id: rae.userId,
        level: "run",
      });
      ids.set(title, id);
    }
    // The description is copied into a version when it is saved, so save once more after patching.
    for (const id of ids.values())
      await h.call(bea, "POST", `/agents/${id}/versions`, {
        instructions: "Do it.",
        promote: true,
      });

    let shown = 0;
    let correct = 0;
    for (const [prompt, want] of prompts) {
      const n = (await h.call(rae, "POST", "/agents/nudge", { prompt })).body.nudge as {
        title: string;
      } | null;
      if (n) shown += 1;
      if (n && n.title === want) correct += 1;
    }
    const wanted = prompts.filter(([, w]) => w !== null).length;
    // Precision@1: of the nudges shown, how many named the right agent. Recall: of the prompts that should nudge.
    expect(wanted).toBe(10);
    expect(correct / shown).toBeGreaterThanOrEqual(0.7);
    expect(correct / wanted).toBeGreaterThanOrEqual(0.7);
    expect(
      (
        await pool.query("select count(*)::int n from work.run where workspace_id = $1", [
          bea.workspaceId,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it("stays quiet about your own agents and after a dismissal", async () => {
    const h = harness([]);
    const p = await workspace({ bea: BUILDER, rae: USER });
    const bea = p.bea as Seeded;
    const rae = p.rae as Seeded;
    const id = (await h.call(bea, "POST", "/agents", { title: "DPIA screening", mode: "scratch" }))
      .body.agent.id as string;
    await h.call(bea, "POST", `/agents/${id}/versions`, { instructions: "x", promote: true });
    expect(
      (await h.call(bea, "POST", "/agents/nudge", { prompt: "do I need a DPIA" })).body.nudge,
    ).toBeNull();
    await h.call(bea, "POST", `/agents/${id}/shares`, {
      principal_type: "user",
      principal_id: rae.userId,
      level: "run",
    });
    expect(
      (await h.call(rae, "POST", "/agents/nudge", { prompt: "do I need a DPIA" })).body.nudge,
    ).toMatchObject({ title: "DPIA screening" });
    expect((await h.call(rae, "POST", `/agents/${id}/nudge/dismiss`)).status).toBe(204);
    expect(
      (await h.call(rae, "POST", "/agents/nudge", { prompt: "do I need a DPIA" })).body.nudge,
    ).toBeNull();
  });
});

describe("a schedule firing", () => {
  const weekly = {
    rule: "weekly",
    params: { weekdays: [1], inputs: "weekly pass" },
    time_local: "08:00",
    tz: "Europe/London",
    email: false,
  };

  it("starts a non-interactive run as its owner on a matching day, and skips others", async () => {
    const h = harness(["Weekly done."]);
    const p = await workspace({ bea: BUILDER });
    const bea = p.bea as Seeded;
    const id = await liveAgent(h, bea);
    await h.call(bea, "PUT", `/agents/${id}/schedule`, weekly);
    const sid = (await pool.query("select id from work.agent_schedule where agent_id = $1", [id]))
      .rows[0].id as string;
    const fire = createScheduleFirer({ pool, agents: h.agents, runs: h.runs });

    expect(await fire(sid, "2026-03-24T08:00:00Z")).toBe("skipped_day");
    expect(await fire(sid, "2026-03-23T08:00:00Z")).toBe("started");
    const run = (
      await pool.query(
        "select id, path, interactive, owner_id from work.run where subject_id = $1",
        [id],
      )
    ).rows;
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({ path: "schedule", interactive: false, owner_id: bea.userId });
    expect(await finish(h, run[0].id)).toEqual({ status: "done" });
    expect((h.prompts[0] ?? []).map((m) => m.content).join("\n")).toContain("weekly pass");
  });

  it("pauses the schedule when the person has lost Run access", async () => {
    const h = harness([]);
    const p = await workspace({ bea: BUILDER, rae: USER });
    const bea = p.bea as Seeded;
    const rae = p.rae as Seeded;
    const id = await liveAgent(h, bea);
    await h.call(bea, "POST", `/agents/${id}/shares`, {
      principal_type: "user",
      principal_id: rae.userId,
      level: "run",
    });
    await h.call(rae, "PUT", `/agents/${id}/schedule`, weekly);
    const sid = (
      await pool.query("select id from work.agent_schedule where agent_id = $1 and user_id = $2", [
        id,
        rae.userId,
      ])
    ).rows[0].id as string;
    const grants = await h.call(bea, "GET", `/agents/${id}/shares`);
    await h.call(bea, "DELETE", `/agents/${id}/shares/${grants.body.grants[0].id}`);
    const fire = createScheduleFirer({ pool, agents: h.agents, runs: h.runs });
    expect(await fire(sid, "2026-03-23T08:00:00Z")).toBe("paused");
    expect(
      (
        await pool.query("select status, paused_reason from work.agent_schedule where id = $1", [
          sid,
        ])
      ).rows[0],
    ).toEqual({ status: "paused", paused_reason: "access_lost" });
    expect(await fire(sid, "2026-03-30T08:00:00Z")).toBe("inactive");
    expect(
      (await pool.query("select count(*)::int n from work.run where subject_id = $1", [id])).rows[0]
        .n,
    ).toBe(0);
  });
});
