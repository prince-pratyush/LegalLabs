import { randomUUID } from "node:crypto";
import { createGateway } from "@legallabs/model-gateway";
import { createLocalEngine } from "@legallabs/runs";
import { CATALOGUE } from "@legallabs/workflows";
import {
  allowAll,
  scriptedDrafts,
  scriptedModel,
  scriptedTables,
} from "@legallabs/workflows/testing";
import { afterAll, describe, expect, it } from "vitest";
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
import { createWorkflows, seedCatalogue } from "./workflows.js";

const pool = testPool();
afterAll(() => pool.end());

// No model is ever called: every port that would spend is scripted.
function harness() {
  const model = scriptedModel();
  const tables = scriptedTables();
  const engine = createLocalEngine({
    pool,
    handlers: runHandlers(pool, {
      ports: {
        model: model.port,
        policy: allowAll(),
        drafts: scriptedDrafts().port,
        tables: tables.port,
      },
    }),
  });
  const agentRuns = createAgentRuns(pool, { engine });
  const documents = testDocuments(pool);
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: testThreads(pool, documents),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
      templates: createTemplatePort(pool),
    }),
    agentRuns,
    workflows: createWorkflows(pool, { documents, agentRuns }),
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
    cookie: string,
    method: string,
    path: string,
    json?: unknown,
  ): Promise<{ status: number; body: Body }> => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const send = async (cookie: string, method: string, path: string, name: string, text: string) => {
    const form = new FormData();
    form.set("file", new File([new TextEncoder().encode(text)], name));
    const res = await app.request(`/api/v1${path}`, { method, headers: { cookie }, body: form });
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { call, send, signIn, engine, model, tables };
}

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
type Body = any;

async function colleague(m: Seeded, permissions: string[]): Promise<Seeded> {
  const email = `ben-${randomUUID().slice(0, 6)}@${m.slug}.test`;
  const role = await pool.query<{ id: string }>(
    "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
    [m.workspaceId, `Role ${email}`, permissions],
  );
  const user = await pool.query<{ id: string }>(
    `insert into core."user" (workspace_id, email, role_id, status) values ($1, $2, $3, 'active') returning id`,
    [m.workspaceId, email, role.rows[0]?.id],
  );
  const userId = user.rows[0]?.id ?? "";
  await pool.query(
    "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
    [m.workspaceId, userId, await hashPassword(PASSWORD)],
  );
  return { slug: m.slug, email, userId, workspaceId: m.workspaceId };
}

const def = (blocks: unknown[], edges: [string, string][], embedded: unknown[] = []) => ({
  schema: "counsel.workflow/1",
  blocks,
  edges: edges.map(([from, to]) => ({ from, to })),
  embedded_files: embedded,
});

const QA = def(
  [
    { type: "user_input.text", id: "q", label: "Question", prompt: "Ask" },
    { type: "ai_action", id: "a", label: "Answer", prompt: "Summarise @Question" },
    { type: "response", id: "out", outputs: [{ ref: "@Answer" }] },
  ],
  [
    ["q", "a"],
    ["a", "out"],
  ],
);

describe("the workflow builder", () => {
  it("creates, validates, saves drafts and publishes only a valid one", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const cookie = await h.signIn(ana);

    const created = await h.call(cookie, "POST", "/workflows", { title: "NDA triage" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: "draft",
      my_access: "full",
      live_definition: null,
    });
    // The canvas starts with the mandatory input and Response blocks.
    expect(created.body.draft_definition.blocks.map((b: { type: string }) => b.type)).toEqual([
      "user_input.text",
      "response",
    ]);
    const id = created.body.id as string;

    const rootless = def(
      [
        { type: "ai_action", id: "a", label: "Answer", prompt: "Hi" },
        { type: "response", id: "out", outputs: [{ ref: "@Answer" }] },
      ],
      [["a", "out"]],
    );
    const saved = await h.call(cookie, "PUT", `/workflows/${id}/draft`, { definition: rootless });
    expect(saved.status).toBe(200);
    expect(saved.body.validation.errors.map((e: { code: string }) => e.code)).toContain(
      "WF_NO_INPUT_START",
    );
    const refused = await h.call(cookie, "POST", `/workflows/${id}/publish`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("WF_INVALID");
    expect(refused.body.errors[0].code).toBe("WF_NO_INPUT_START");

    const threeSources = await h.call(cookie, "POST", `/workflows/${id}/validate`, {
      definition: def(
        [
          { type: "user_input.text", id: "q", label: "Question", prompt: "Ask" },
          {
            type: "ai_action",
            id: "a",
            label: "Answer",
            prompt: "Research @Question",
            sources: ["a", "b", "c"].map((s) => ({ kind: "knowledge_source", source: s })),
          },
          { type: "response", id: "out", outputs: [{ ref: "@Answer" }] },
        ],
        [
          ["q", "a"],
          ["a", "out"],
        ],
      ),
    });
    expect(threeSources.body.errors.map((e: { code: string }) => e.code)).toEqual([
      "WF_SOURCES_MAX",
    ]);
    const garbage = await h.call(cookie, "POST", `/workflows/${id}/validate`, {
      definition: { x: 1 },
    });
    expect(garbage.status).toBe(400);
    expect(garbage.body.code).toBe("SCHEMA_INVALID");

    expect((await h.call(cookie, "PUT", `/workflows/${id}/draft`, { definition: QA })).status).toBe(
      200,
    );
    const published = await h.call(cookie, "POST", `/workflows/${id}/publish`);
    expect(published).toMatchObject({ status: 200, body: { version_no: 3 } });
    const got = await h.call(cookie, "GET", `/workflows/${id}`);
    expect(got.body).toMatchObject({ status: "live", live_version_no: 3, draft_definition: null });
    const form = await h.call(cookie, "GET", `/workflows/${id}/intake-form`);
    expect(form.body.inputs.map((b: { label: string }) => b.label)).toEqual(["Question"]);

    const actions = (await auditTrail(pool, ana.workspaceId)).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["workflow.created", "workflow.draft.saved", "workflow.published"]),
    );
  });

  it("keeps workflows to people with the right permissions", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const runner = await colleague(ana, ["agents.use", "threads.use"]);
    const anaCookie = await h.signIn(ana);
    const runnerCookie = await h.signIn(runner);
    const { body } = await h.call(anaCookie, "POST", "/workflows", { title: "Private" });
    expect((await h.call(runnerCookie, "GET", `/workflows/${body.id}`)).status).toBe(404);
    expect((await h.call(runnerCookie, "POST", "/workflows", { title: "Mine" })).status).toBe(403);
  });

  it("seeds the catalogue once, read-only, and duplicates it to edit", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const cookie = await h.signIn(ana);
    const listed = await h.call(cookie, "GET", "/workflows?filter[catalogue]=true");
    expect(listed.body.workflows).toHaveLength(CATALOGUE.length);
    expect(
      listed.body.workflows.every(
        (w: { status: string; my_access: string }) => w.status === "live" && w.my_access === "view",
      ),
    ).toBe(true);
    expect(await seedCatalogue(pool, ana.workspaceId)).toBe(0);
    expect(
      (await h.call(cookie, "GET", "/workflows?filter[catalogue]=true")).body.workflows,
    ).toHaveLength(15);

    const timeline = listed.body.workflows.find(
      (w: { catalogue_key: string }) => w.catalogue_key === "timeline",
    );
    const edit = await h.call(cookie, "PUT", `/workflows/${timeline.id}/draft`, { definition: QA });
    expect(edit.status).toBe(403);
    expect((await h.call(cookie, "DELETE", `/workflows/${timeline.id}`)).status).toBe(403);
    const copy = await h.call(cookie, "POST", `/workflows/${timeline.id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({
      title: "Extract Timeline of Key Events (copy)",
      catalogue: false,
      my_access: "full",
    });
    expect(copy.body.draft_definition).toEqual(
      CATALOGUE.find((e) => e.key === "timeline")?.definition,
    );
  });

  it("refuses the 11th file on Translate's intake form", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const cookie = await h.signIn(ana);
    const listed = await h.call(cookie, "GET", "/workflows?filter[catalogue]=true");
    const translate = listed.body.workflows.find(
      (w: { catalogue_key: string }) => w.catalogue_key === "translate",
    );
    const files = Array.from({ length: 11 }, () => ({ kind: "upload", ref: randomUUID() }));
    const run = await h.call(cookie, "POST", `/workflows/${translate.id}/run`, {
      inputs: { Documents: files, Language: "fr" },
    });
    expect(run.status).toBe(400);
    expect(run.body.code).toBe("INPUT_INVALID");
    expect(run.body.issues).toEqual([
      expect.objectContaining({ code: "INPUT_TOO_MANY_FILES", label: "Documents" }),
    ]);
  });
});

describe("a workflow run through the API", () => {
  it("starts as a workflow run, executes every block and posts to the thread", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const cookie = await h.signIn(ana);
    const { body } = await h.call(cookie, "POST", "/workflows", {
      title: "Q and A",
      definition: QA,
    });
    await h.call(cookie, "POST", `/workflows/${body.id}/publish`);

    const bad = await h.call(cookie, "POST", `/workflows/${body.id}/run`, { inputs: {} });
    expect(bad.body.issues[0].code).toBe("INPUT_REQUIRED");

    const started = await h.call(cookie, "POST", `/workflows/${body.id}/run`, {
      inputs: { Question: "When does the lease end?" },
    });
    expect(started.status).toBe(201);
    const { run_id, thread_id } = started.body;
    expect(await h.engine.result(run_id)).toEqual({ status: "done" });

    const run = await pool.query(
      "select kind, subject_id, status, cost_usd::float8 cost, inputs from work.run where id = $1",
      [run_id],
    );
    expect(run.rows[0]).toMatchObject({
      kind: "workflow",
      subject_id: body.id,
      status: "done",
      inputs: { Question: "When does the lease end?" },
    });
    const steps = await pool.query<{
      block_id: string;
      kind: string;
      cost: number;
      model: string | null;
    }>(
      "select block_id, kind, coalesce(cost_usd, 0)::float8 cost, model from work.run_step where run_id = $1 order by ordinal",
      [run_id],
    );
    expect(steps.rows.map((s) => [s.kind, s.block_id])).toEqual([
      ["block", "q"],
      ["block", "a"],
      ["block", "out"],
    ]);
    const sum = steps.rows.reduce((t, s) => t + s.cost, 0);
    expect(Math.abs(run.rows[0].cost - sum)).toBeLessThan(0.0001);
    expect(steps.rows[1]?.model).toBe("scripted/summarise");

    const messages = await pool.query<{ role: string; content: string }>(
      "select role, content from work.message where thread_id = $1 order by created_at, id",
      [thread_id],
    );
    expect(messages.rows.at(-1)?.content).toContain("When does the lease end?");
    const outputs = await pool.query(
      "select data from work.run_event where run_id = $1 and type = 'output'",
      [run_id],
    );
    expect(outputs.rows).toHaveLength(1);
    const listed = await h.call(
      cookie,
      "GET",
      `/runs?filter[kind]=workflow&filter[subject_id]=${body.id}`,
    );
    expect(listed.body.runs).toHaveLength(1);
  });

  it("runs a catalogue workflow on uploaded files", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const cookie = await h.signIn(ana);
    const docs = [];
    for (const name of ["Letter one.txt", "Letter two.txt"]) {
      const up = await h.send(
        cookie,
        "POST",
        "/documents",
        name,
        `On 1 May the parties met. ${name}`,
      );
      expect(up.status).toBe(202);
      docs.push({ kind: "upload", ref: up.body.document.id });
    }
    const listed = await h.call(cookie, "GET", "/workflows?filter[catalogue]=true");
    const timeline = listed.body.workflows.find(
      (w: { catalogue_key: string }) => w.catalogue_key === "timeline",
    );
    const started = await h.call(cookie, "POST", `/workflows/${timeline.id}/run`, {
      inputs: { Documents: docs },
    });
    expect(started.status).toBe(201);
    expect(await h.engine.result(started.body.run_id)).toEqual({ status: "done" });
    // The table read both files through the runner's own access.
    expect(h.tables.calls).toEqual(["generate:all"]);
    const kinds = await pool.query(
      "select data->>'kind' kind from work.run_event where run_id = $1 and type = 'output' order by seq",
      [started.body.run_id],
    );
    expect(kinds.rows.map((r) => r.kind)).toEqual(["table", "message"]);
  });
});

describe("embedded files", () => {
  it("lists, replaces for every workflow using it, and refuses removal while in use", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const cookie = await h.signIn(ana);
    const one = (await h.call(cookie, "POST", "/workflows", { title: "One" })).body.id as string;
    const two = (await h.call(cookie, "POST", "/workflows", { title: "Two" })).body.id as string;

    const up = await h.send(
      cookie,
      "POST",
      `/workflows/${one}/files`,
      "Playbook.txt",
      "Cap at fees.",
    );
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ label: "Playbook", name: "Playbook.txt", version_no: 1 });
    const docId = up.body.document_id as string;
    // Embedded files never show among a person's own documents.
    const mine = await h.call(cookie, "GET", "/documents");
    expect(JSON.stringify(mine.body)).not.toContain(docId);

    const using = (title: string) =>
      def(
        [
          { type: "user_input.text", id: "q", label: "Question", prompt: "Ask" },
          {
            type: "ai_action",
            id: "check",
            label: title,
            prompt: "Check @Question against the playbook",
            context: [{ kind: "upload", ref: docId }],
          },
          { type: "response", id: "out", outputs: [{ ref: `@${title}` }] },
        ],
        [
          ["q", "check"],
          ["check", "out"],
        ],
        [{ document_id: docId, label: "Playbook" }],
      );
    for (const [id, title] of [
      [one, "Checked"],
      [two, "Reviewed"],
    ] as const) {
      expect(
        (await h.call(cookie, "PUT", `/workflows/${id}/draft`, { definition: using(title) }))
          .status,
      ).toBe(200);
      expect((await h.call(cookie, "POST", `/workflows/${id}/publish`)).status).toBe(200);
    }

    const files = await h.call(cookie, "GET", `/workflows/${two}/files`);
    expect(files.body.files).toEqual([
      expect.objectContaining({ document_id: docId, referenced_by: ["check"], label: "Playbook" }),
    ]);

    const busy = await h.call(cookie, "DELETE", `/workflows/${one}/files/${docId}`);
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ code: "FILE_IN_USE", block_ids: ["check"] });

    const replaced = await h.send(
      cookie,
      "PUT",
      `/workflows/${two}/files/${docId}`,
      "Playbook.txt",
      "Cap at twice fees.",
    );
    expect(replaced.status).toBe(200);
    expect(replaced.body.version_no).toBe(2);
    expect([...replaced.body.affected_workflows].sort()).toEqual([one, two].sort());
    const events = (await auditTrail(pool, ana.workspaceId)).filter(
      (e) => e.action === "workflow.file_replaced",
    );
    expect(events.map((e) => e.object_id).sort()).toEqual([one, two].sort());

    // Both workflows' next runs read the new version.
    const { rows } = await pool.query<{ id: string }>(
      "select id from content.document_version where document_id = $1 and version_no = 2",
      [docId],
    );
    for (const id of [one, two]) {
      const started = await h.call(cookie, "POST", `/workflows/${id}/run`, {
        inputs: { Question: "Cap?" },
      });
      expect(await h.engine.result(started.body.run_id)).toEqual({ status: "done" });
      expect(h.model.calls.at(-1)?.documents.map((d) => d.version_id)).toEqual([rows[0]?.id]);
    }

    // Once no block uses it, it can go.
    for (const id of [one, two]) {
      await h.call(cookie, "PUT", `/workflows/${id}/draft`, { definition: QA });
      await h.call(cookie, "POST", `/workflows/${id}/publish`);
    }
    expect((await h.call(cookie, "DELETE", `/workflows/${one}/files/${docId}`)).status).toBe(204);
    expect((await h.call(cookie, "GET", `/workflows/${one}/files`)).body.files).toEqual([]);
  });
});
