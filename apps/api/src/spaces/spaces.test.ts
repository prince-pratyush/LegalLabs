import { randomUUID } from "node:crypto";
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
import type { NotifyEvent } from "./kit.js";
import { createSpaceModule } from "./module.js";
import { type ScriptedOptions, scriptedTaskRuns } from "./ports.js";

const pool = testPool();
afterAll(() => pool.end());

const one = async (sql: string, params: unknown[]) =>
  (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";

/** A second or third person in the workspace, holding the permissions given. */
async function person(m: Seeded, name: string, permissions: string[]): Promise<Seeded> {
  const email = `${name}-${randomUUID().slice(0, 6)}@${m.slug}.test`;
  const role = await one(
    "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
    [m.workspaceId, `Role ${email}`, permissions],
  );
  const userId = await one(
    `insert into core."user" (workspace_id, email, role_id, status) values ($1, $2, $3, 'active') returning id`,
    [m.workspaceId, email, role],
  );
  await pool.query(
    "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
    [m.workspaceId, userId, await hashPassword(PASSWORD)],
  );
  return { slug: m.slug, email, userId, workspaceId: m.workspaceId };
}

const matter = (m: Seeded, mode: "open" | "allow_list", number: string) =>
  one(
    `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name, wall_mode)
     values ($1, '00123', 'Acme Corp', $2, $2, $3) returning id`,
    [m.workspaceId, number, mode],
  );

const vault = (m: Seeded, owner: string, matterId: string | null = null) =>
  one(
    `insert into content.vault (workspace_id, owner_id, name, matter_id)
     values ($1, $2, 'Data room', $3) returning id`,
    [m.workspaceId, owner, matterId],
  );

const USER = ["threads.use", "spaces.create"];

/** Ids in the API are version 7, as the database makes them. */
const uuid7 = () => one("select core.uuid7() as id", []);

async function world(runOptions: ScriptedOptions = {}) {
  const ana = await seedMember(pool);
  const ben = await person(ana, "ben", USER);
  const cal = await person(ana, "cal", USER);
  const agentId = await uuid7();
  const runs = scriptedTaskRuns({
    firstLook: () => ({ status: "running", outputs: [] }),
    ...runOptions,
  });
  const events: NotifyEvent[] = [];
  const documents = testDocuments(pool);
  const spaces = createSpaceModule(pool, {
    runs,
    notifier: {
      notify: async (_p, event) => {
        events.push(event);
      },
    },
    // The agents epic registers real agents; here one agent exists, owned by Ana.
    catalog: {
      agent: async (_db, id) =>
        id === agentId
          ? { name: "Diligence agent", ownerId: ana.userId, matterId: null, full: true }
          : null,
    },
  });
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: testThreads(pool, documents),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
      templates: { resolve: async () => null },
    }),
    spaces,
    clientIp: () => "203.0.113.9",
  });
  const cookies = new Map<string, string>();
  const signIn = async (m: Seeded) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
    });
    cookies.set(m.userId, (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "");
  };
  await Promise.all([signIn(ana), signIn(ben), signIn(cal)]);
  const as = (m: Seeded) => async (method: string, path: string, json?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: {
        cookie: cookies.get(m.userId) ?? "",
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    const type = res.headers.get("content-type") ?? "";
    return {
      status: res.status,
      // biome-ignore lint/suspicious/noExplicitAny: test responses are checked field by field
      body: (text && type.includes("json") ? JSON.parse(text) : text) as any,
    };
  };
  return { ana, ben, cal, agentId, runs, events, spaces, a: as(ana), b: as(ben), c: as(cal) };
}

type World = Awaited<ReturnType<typeof world>>;

/** A Space of Ana's with Ben in it. */
async function room(w: World, name = "Deal room") {
  const created = await w.a("POST", "/spaces", { name });
  const id: string = created.body.space.id;
  await w.a("POST", `/spaces/${id}/members`, {
    principal_type: "user",
    principal_id: w.ben.userId,
    role: "collaborator",
  });
  return id;
}

const shareAgent = (w: World, id: string) =>
  w.a("POST", `/spaces/${id}/resources`, {
    resource_type: "agent",
    resource_id: w.agentId,
    access: "run",
  });

const actionsOf = async (w: World) =>
  (await auditTrail(pool, w.ana.workspaceId)).map((e) => e.action);

describe("spaces", () => {
  it("makes the creator its admin, lists it to members only, and audits it", async () => {
    const w = await world();
    const id = await room(w);
    const mine = await w.a("GET", "/spaces?filter[member]=me");
    expect(mine.body.spaces.map((s: { id: string }) => s.id)).toContain(id);
    expect((await w.a("GET", `/spaces/${id}`)).body.space.my_role).toBe("admin");
    expect((await w.b("GET", `/spaces/${id}`)).body.space.my_role).toBe("collaborator");
    // Cal is not in it.
    expect((await w.c("GET", `/spaces/${id}`)).status).toBe(404);
    const actions = await actionsOf(w);
    expect(actions).toContain("space.created");
    expect(actions).toContain("space.member_added");
  });

  it("refuses a second Space for one matter, and a duplicate name", async () => {
    const w = await world();
    const m = await matter(w.ana, "open", "M-1");
    expect((await w.a("POST", "/spaces", { name: "One", matter_id: m })).status).toBe(201);
    const second = await w.a("POST", "/spaces", { name: "Two", matter_id: m });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("MATTER_HAS_SPACE");
    const dup = await w.a("POST", "/spaces", { name: "ONE" });
    expect(dup.body.code).toBe("NAME_TAKEN");
  });

  it("shows the matter as the display string every list uses", async () => {
    const w = await world();
    const m = await matter(w.ana, "open", "0001");
    const made = await w.a("POST", "/spaces", { name: "Matter room", matter_id: m });
    expect(made.body.space.matter.display).toBe("00123-0001 Acme Corp");
  });

  it("keeps the context to admins and bumps its version", async () => {
    const w = await world();
    const id = await room(w);
    const context = {
      parties: [{ name: "Acme Holdings", role: "buyer" }],
      key_dates: [{ label: "Signing", date: "2026-12-01" }],
      standing_instructions: "Always refer to the buyer as Acme Holdings",
    };
    expect((await w.b("PUT", `/spaces/${id}/context`, context)).status).toBe(403);
    const set = await w.a("PUT", `/spaces/${id}/context`, context);
    expect(set.status).toBe(200);
    expect(set.body.space.context.version).toBe(2);
    expect((await w.a("PUT", `/spaces/${id}/context`, context)).body.space.context.version).toBe(3);
    expect(await actionsOf(w)).toContain("space.context_updated");
  });

  it("keeps at least one admin", async () => {
    const w = await world();
    const id = await room(w);
    const members = (await w.a("GET", `/spaces/${id}/members`)).body.members;
    const admin = members.find((m: { role: string }) => m.role === "admin");
    expect((await w.a("DELETE", `/spaces/${id}/members/${admin.id}`)).body.code).toBe("LAST_ADMIN");
    expect(
      (await w.a("PATCH", `/spaces/${id}/members/${admin.id}`, { role: "collaborator" })).body.code,
    ).toBe("LAST_ADMIN");
  });

  it("deletes softly: gone from every list and by id", async () => {
    const w = await world();
    const id = await room(w);
    expect((await w.b("DELETE", `/spaces/${id}`)).status).toBe(403);
    expect((await w.a("DELETE", `/spaces/${id}`)).status).toBe(204);
    expect((await w.a("GET", `/spaces/${id}`)).status).toBe(404);
    expect((await w.b("GET", `/spaces/${id}`)).status).toBe(404);
  });

  it("refuses an external Space until they exist", async () => {
    const w = await world();
    const res = await w.a("POST", "/spaces", { name: "Ext", kind: "external" });
    expect(res.body.code).toBe("EXTERNAL_NOT_ENABLED");
  });
});

describe("resources", () => {
  const hasAccess = async (m: Seeded, vaultId: string) => {
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("set local role legallabs_app");
      await db.query(
        "select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
        [m.userId, m.workspaceId],
      );
      const { rows } = await db.query("select core.has_access('vault', $1, 'view') as ok", [
        vaultId,
      ]);
      return rows[0]?.ok as boolean;
    } finally {
      await db.query("rollback");
      db.release();
    }
  };

  it("lets members reach a shared vault, and stops when the grant is removed", async () => {
    const w = await world();
    const id = await room(w);
    const v = await vault(w.ana, w.ana.userId);
    expect(await hasAccess(w.ben, v)).toBe(false);
    const added = await w.a("POST", `/spaces/${id}/resources`, {
      resource_type: "vault",
      resource_id: v,
      access: "view",
    });
    expect(added.status).toBe(201);
    expect(added.body.resource.name).toBe("Data room");
    expect(await hasAccess(w.ben, v)).toBe(true);
    // Cal is not in the Space.
    expect(await hasAccess(w.cal, v)).toBe(false);
    await w.a("DELETE", `/spaces/${id}/resources/${added.body.resource.id}`);
    expect(await hasAccess(w.ben, v)).toBe(false);
  });

  it("needs Full on the resource to share it, and hides what the caller can't see", async () => {
    const w = await world();
    const id = await room(w);
    const v = await vault(w.ana, w.ana.userId);
    // Ben is in the Space but has no access to Ana's vault at all.
    const res = await w.b("POST", `/spaces/${id}/resources`, {
      resource_type: "vault",
      resource_id: v,
      access: "view",
    });
    expect(res.body.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("won't let an admin raise a shared resource past what they hold themselves", async () => {
    const w = await world();
    const id = await room(w);
    const v = await vault(w.ana, w.ana.userId);
    // Ben owns a vault and shares it at view; Ana, a Space admin, can't raise it to full.
    const bens = await vault(w.ana, w.ben.userId);
    const added = await w.b("POST", `/spaces/${id}/resources`, {
      resource_type: "vault",
      resource_id: bens,
      access: "view",
    });
    expect(added.status).toBe(201);
    const raised = await w.a("PATCH", `/spaces/${id}/resources/${added.body.resource.id}`, {
      access: "full",
    });
    expect(raised.status).toBe(403);
    // Lowering is always allowed.
    await w.b("PATCH", `/spaces/${id}/resources/${added.body.resource.id}`, { access: "edit" });
    const lowered = await w.a("PATCH", `/spaces/${id}/resources/${added.body.resource.id}`, {
      access: "view",
    });
    expect(lowered.status).toBe(200);
    expect(v).toBeTruthy();
  });

  it("doesn't offer types whose own access ignores Space grants", async () => {
    const w = await world();
    const id = await room(w);
    const res = await w.a("POST", `/spaces/${id}/resources`, {
      resource_type: "review_table",
      resource_id: await uuid7(),
      access: "view",
    });
    expect(res.body.code).toBe("RESOURCE_UNSUPPORTED");
  });

  it("blocks a resource from a different matter", async () => {
    const w = await world();
    const m1 = await matter(w.ana, "open", "A-1");
    const m2 = await matter(w.ana, "open", "A-2");
    const made = await w.a("POST", "/spaces", { name: "Matter A", matter_id: m1 });
    const v = await vault(w.ana, w.ana.userId, m2);
    const res = await w.a("POST", `/spaces/${made.body.space.id}/resources`, {
      resource_type: "vault",
      resource_id: v,
      access: "view",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MATTER_MISMATCH");
  });

  it("refuses a run level on a vault and a type with no source yet", async () => {
    const w = await world();
    const id = await room(w);
    const v = await vault(w.ana, w.ana.userId);
    const run = await w.a("POST", `/spaces/${id}/resources`, {
      resource_type: "vault",
      resource_id: v,
      access: "run",
    });
    expect(run.body.code).toBe("INVALID");
    const workflow = await w.a("POST", `/spaces/${id}/resources`, {
      resource_type: "workflow",
      resource_id: await uuid7(),
      access: "run",
    });
    expect(workflow.body.code).toBe("RESOURCE_UNSUPPORTED");
  });
});

describe("tasks", () => {
  it("runs a task assigned to an agent, then returns it to its creator with the output", async () => {
    const w = await world();
    const id = await room(w);
    await w.a("PUT", `/spaces/${id}/context`, {
      parties: [],
      key_dates: [],
      standing_instructions: "Always refer to the buyer as Acme Holdings",
    });
    await w.a("PATCH", `/spaces/${id}`, { customization: { agent_runs_interactive: false } });
    expect((await shareAgent(w, id)).status).toBe(201);

    const created = await w.a("POST", `/spaces/${id}/tasks`, {
      name: "Review the supply agreement",
      description_md: "Flag termination rights.",
      assignee: { type: "agent", agent_id: w.agentId },
    });
    expect(created.status).toBe(201);
    const task = created.body.task;
    expect(task.status).toBe("in_progress");
    expect(task.assignee).toEqual({ type: "agent", agent_id: w.agentId });
    expect(task.run.status).toBe("running");
    expect(task.run.thread_id).toBeTruthy();

    // What the engine was asked to do: the Space Context first, then the task.
    const run = w.runs.runs[0];
    expect(run?.input.interactive).toBe(false);
    expect(run?.input.prompt).toContain("<space_context");
    expect(run?.input.prompt).toContain("Always refer to the buyer as Acme Holdings");
    expect(run?.input.prompt).toContain("Review the supply agreement");
    expect(run?.input.assignee).toEqual({ type: "agent", agentId: w.agentId });

    const output = { kind: "message" as const, id: await uuid7() };
    w.runs.finish(task.run.id, {
      status: "done",
      summary: "Two termination rights flagged.",
      outputs: [output],
    });
    // The engine says it ended; Spaces reads the run once and settles the task.
    await w.spaces.tasks.runFinished(
      { workspaceId: w.ana.workspaceId, userId: w.ana.userId },
      task.run.id,
      { ip: null, userAgent: null },
    );

    const back = (await w.a("GET", `/tasks/${task.id}`)).body.task;
    expect(back.assignee).toEqual({ type: "user", user_id: w.ana.userId });
    expect(back.status).toBe("in_progress");
    expect(back.linked.outputs).toEqual([output]);
    expect(back.run.status).toBe("done");
    const comments = (await w.a("GET", `/tasks/${task.id}/comments`)).body.comments;
    expect(comments.at(-1)).toMatchObject({
      author_type: "assistant",
      body_md: "Completed: Two termination rights flagged.",
    });
    expect(w.events.find((e) => e.kind === "task.returned")?.userIds).toEqual([w.ana.userId]);
    const actions = await actionsOf(w);
    expect(actions).toContain("task.assigned");
    expect(actions).toContain("task.returned");
    // Closing it is up to its creator.
    const closed = await w.a("PATCH", `/tasks/${task.id}`, { status: "done" });
    expect(closed.body.task.status).toBe("done");
  });

  it("returns a task by itself when it is read later, with no push from the engine", async () => {
    const w = await world({
      firstLook: () => ({ status: "done", summary: "Done.", outputs: [] }),
    });
    const id = await room(w);
    await shareAgent(w, id);
    const created = await w.a("POST", `/spaces/${id}/tasks`, {
      name: "Summarise",
      assignee: { type: "agent", agent_id: w.agentId },
    });
    // Reading the task heals a missed call.
    const read = await w.a("GET", `/tasks/${created.body.task.id}`);
    expect(read.body.task.assignee.type).toBe("user");
    // Reading again does not return it twice.
    await w.a("GET", `/tasks/${created.body.task.id}`);
    const comments = (await w.a("GET", `/tasks/${created.body.task.id}/comments`)).body.comments;
    expect(
      comments.filter((c: { body_md: string }) => c.body_md.startsWith("Completed")),
    ).toHaveLength(1);
  });

  it("gives the work to the assistant too, and reports a failure", async () => {
    const w = await world();
    const id = await room(w);
    const created = await w.b("POST", `/spaces/${id}/tasks`, {
      name: "Draft a summary",
      assignee: { type: "assistant" },
    });
    expect(created.body.task.assignee).toEqual({ type: "assistant" });
    expect(w.runs.runs[0]?.input.assignee).toEqual({ type: "assistant" });
    w.runs.finish(created.body.task.run.id, { status: "failed", error: "No sources" });
    const back = (await w.b("GET", `/tasks/${created.body.task.id}`)).body.task;
    expect(back.assignee).toEqual({ type: "user", user_id: w.ben.userId });
    const comments = (await w.b("GET", `/tasks/${back.id}/comments`)).body.comments;
    expect(comments.at(-1).body_md).toBe("Stopped: No sources");
  });

  it("surfaces a run's question as a comment and passes the answer on", async () => {
    const w = await world();
    const id = await room(w);
    const created = await w.a("POST", `/spaces/${id}/tasks`, {
      name: "Check the schedule",
      assignee: { type: "assistant" },
    });
    w.runs.finish(created.body.task.run.id, {
      status: "awaiting_input",
      question: "Which schedule?",
    });
    const asked = (await w.a("GET", `/tasks/${created.body.task.id}/comments`)).body.comments;
    // Read through the task, which settles the run's state first.
    await w.a("GET", `/tasks/${created.body.task.id}`);
    const withQuestion = (await w.a("GET", `/tasks/${created.body.task.id}/comments`)).body
      .comments;
    expect(asked.length).toBeLessThanOrEqual(withQuestion.length);
    expect(withQuestion.at(-1).body_md).toBe("Question: Which schedule?");
    const answered = await w.a("POST", `/tasks/${created.body.task.id}/answer`, {
      answer: "Schedule 2",
    });
    expect(answered.status).toBe(200);
    expect(w.runs.runs[0]?.answers).toEqual(["Schedule 2"]);
  });

  it("drops a run that started after the task was handed on", async () => {
    let hand: (() => Promise<unknown>) | null = null;
    const w = await world({ duringStart: async () => void (await hand?.()) });
    const id = await room(w);
    // While the engine starts the assistant's run, the task is handed to Ben.
    const taskId = (await w.a("POST", `/spaces/${id}/tasks`, { name: "Existing" })).body.task.id;
    hand = () =>
      w.a("PATCH", `/tasks/${taskId}`, { assignee: { type: "user", user_id: w.ben.userId } });
    const res = await w.a("PATCH", `/tasks/${taskId}`, { assignee: { type: "assistant" } });
    expect(res.status).toBe(200);
    const after = (await w.a("GET", `/tasks/${taskId}`)).body.task;
    expect(after.assignee).toEqual({ type: "user", user_id: w.ben.userId });
    expect(after.run).toBeNull();
    expect(w.runs.runs[0]?.cancelled).toBe(true);
  });

  it("leaves the question standing when the engine can't take an answer", async () => {
    const w = await world({ failAnswer: true });
    const id = await room(w);
    const created = await w.a("POST", `/spaces/${id}/tasks`, {
      name: "Check",
      assignee: { type: "assistant" },
    });
    w.runs.finish(created.body.task.run.id, { status: "awaiting_input", question: "Which?" });
    await w.a("GET", `/tasks/${created.body.task.id}`);
    const res = await w.a("POST", `/tasks/${created.body.task.id}/answer`, { answer: "Two" });
    expect(res.status).toBe(502);
    const comments = (await w.a("GET", `/tasks/${created.body.task.id}/comments`)).body.comments;
    expect(comments.map((c: { body_md: string }) => c.body_md)).toEqual(["Question: Which?"]);
    expect((await w.a("GET", `/tasks/${created.body.task.id}`)).body.task.run.status).toBe(
      "awaiting_input",
    );
  });

  it("asks a question once, however often the task is read", async () => {
    const w = await world();
    const id = await room(w);
    const created = await w.a("POST", `/spaces/${id}/tasks`, {
      name: "Check",
      assignee: { type: "assistant" },
    });
    w.runs.finish(created.body.task.run.id, { status: "awaiting_input", question: "Which?" });
    await w.a("GET", `/tasks/${created.body.task.id}`);
    await w.a("GET", `/tasks/${created.body.task.id}`);
    await w.a("GET", `/spaces/${id}/tasks`);
    const comments = (await w.a("GET", `/tasks/${created.body.task.id}/comments`)).body.comments;
    expect(comments).toHaveLength(1);
  });

  it("keeps a task as it was when the engine can't be reached for its status", async () => {
    const w = await world();
    const id = await room(w);
    const created = await w.a("POST", `/spaces/${id}/tasks`, {
      name: "Check",
      assignee: { type: "assistant" },
    });
    w.runs.runs.length = 0; // the engine has forgotten the run, so status() throws
    const read = await w.a("GET", `/tasks/${created.body.task.id}`);
    expect(read.status).toBe(200);
    expect(read.body.task.assignee).toEqual({ type: "assistant" });
  });

  it("ignores a finished call for an unknown run", async () => {
    const w = await world();
    const done = await w.spaces.tasks.runFinished(
      { workspaceId: w.ana.workspaceId, userId: w.ana.userId },
      "not-an-id",
      { ip: null, userAgent: null },
    );
    expect(done).toEqual({ ok: true, value: null });
  });

  it("needs an agent shared into the Space at Run", async () => {
    const w = await world();
    const id = await room(w);
    const res = await w.a("POST", `/spaces/${id}/tasks`, {
      name: "T",
      assignee: { type: "agent", agent_id: w.agentId },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("AGENT_NOT_SHARED");
  });

  it("leaves a task unassigned when the run can't start", async () => {
    const w = await world({ failStart: true });
    const id = await room(w);
    const res = await w.a("POST", `/spaces/${id}/tasks`, {
      name: "T",
      assignee: { type: "assistant" },
    });
    expect(res.status).toBe(502);
    const list = (await w.a("GET", `/spaces/${id}/tasks`)).body.tasks;
    expect(list[0]).toMatchObject({ name: "T", assignee: null, status: "todo", run: null });
  });

  it("cancels the run when the task is handed on", async () => {
    const w = await world();
    const id = await room(w);
    const created = await w.a("POST", `/spaces/${id}/tasks`, {
      name: "T",
      assignee: { type: "assistant" },
    });
    const patched = await w.a("PATCH", `/tasks/${created.body.task.id}`, {
      assignee: { type: "user", user_id: w.ben.userId },
    });
    expect(patched.body.task.assignee).toEqual({ type: "user", user_id: w.ben.userId });
    expect(w.runs.runs[0]?.cancelled).toBe(true);
    // The old run reports nothing more to the task.
    w.runs.finish(created.body.task.run.id, { status: "done", summary: "late" });
    const after = (await w.a("GET", `/tasks/${created.body.task.id}`)).body.task;
    expect(after.assignee).toEqual({ type: "user", user_id: w.ben.userId });
  });

  it("cancels the run when the task is cancelled", async () => {
    const w = await world();
    const id = await room(w);
    const created = await w.a("POST", `/spaces/${id}/tasks`, {
      name: "T",
      assignee: { type: "assistant" },
    });
    const cancelled = await w.a("PATCH", `/tasks/${created.body.task.id}`, { status: "cancelled" });
    expect(cancelled.body.task.status).toBe("cancelled");
    expect(w.runs.runs[0]?.cancelled).toBe(true);
  });

  it("assigns only to people in the Space", async () => {
    const w = await world();
    const id = await room(w);
    const res = await w.a("POST", `/spaces/${id}/tasks`, {
      name: "T",
      assignee: { type: "user", user_id: w.cal.userId },
    });
    expect(res.body.code).toBe("INVALID_ASSIGNEE");
  });

  it("holds a gate for approval and locks the next phase until it is approved", async () => {
    const w = await world();
    const id = await room(w);
    const p1 = (await w.a("POST", `/spaces/${id}/phases`, { name: "Diligence" })).body.phase.id;
    const p2 = (await w.a("POST", `/spaces/${id}/phases`, { name: "Signing" })).body.phase.id;
    const gate = (
      await w.a("POST", `/spaces/${id}/tasks`, {
        name: "Partner sign-off",
        phase_id: p1,
        gate: true,
      })
    ).body.task;
    const later = (
      await w.a("POST", `/spaces/${id}/tasks`, { name: "Prepare execution copies", phase_id: p2 })
    ).body.task;

    // Only an admin makes a gate.
    const sneaky = await w.b("POST", `/spaces/${id}/tasks`, {
      name: "G",
      phase_id: p1,
      gate: true,
    });
    expect(sneaky.status).toBe(403);

    const marked = await w.b("PATCH", `/tasks/${gate.id}`, { status: "done" });
    expect(marked.body.task).toMatchObject({ status: "in_progress", awaiting_approval: true });
    const locked = await w.b("PATCH", `/tasks/${later.id}`, { status: "in_progress" });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe("PHASE_LOCKED");
    expect((await w.a("GET", `/spaces/${id}/phases`)).body.phases[1]).toMatchObject({
      locked: true,
    });
    expect((await w.b("POST", `/tasks/${gate.id}/approve`)).status).toBe(403);

    const approved = await w.a("POST", `/tasks/${gate.id}/approve`);
    expect(approved.body.task).toMatchObject({ status: "done", awaiting_approval: false });
    expect(approved.body.task.approved_by).toBe(w.ana.userId);
    const unlocked = await w.b("PATCH", `/tasks/${later.id}`, { status: "in_progress" });
    expect(unlocked.status).toBe(200);
    expect(await actionsOf(w)).toContain("task.gate_approved");
    const feed = (await w.a("GET", `/spaces/${id}/activity`)).body.items.map(
      (i: { type: string }) => i.type,
    );
    expect(feed).toContain("phase.unlocked");
  });

  it("sends a rejected gate back to To do with a required comment", async () => {
    const w = await world();
    const id = await room(w);
    const p1 = (await w.a("POST", `/spaces/${id}/phases`, { name: "One" })).body.phase.id;
    const gate = (await w.a("POST", `/spaces/${id}/tasks`, { name: "G", phase_id: p1, gate: true }))
      .body.task;
    await w.b("PATCH", `/tasks/${gate.id}`, { status: "done" });
    expect((await w.a("POST", `/tasks/${gate.id}/reject`, { comment: "  " })).body.code).toBe(
      "COMMENT_REQUIRED",
    );
    const rejected = await w.a("POST", `/tasks/${gate.id}/reject`, {
      comment: "Missing the schedule.",
    });
    expect(rejected.body.task).toMatchObject({ status: "todo", awaiting_approval: false });
    const comments = (await w.a("GET", `/tasks/${gate.id}/comments`)).body.comments;
    expect(comments.at(-1).body_md).toBe("Missing the schedule.");
    // Nothing to reject now.
    expect((await w.a("POST", `/tasks/${gate.id}/reject`, { comment: "x" })).body.code).toBe(
      "NOT_AWAITING_APPROVAL",
    );
    expect(await actionsOf(w)).toContain("task.gate_rejected");
  });

  it("lets an admin open a locked phase, audited", async () => {
    const w = await world();
    const id = await room(w);
    const p1 = (await w.a("POST", `/spaces/${id}/phases`, { name: "One" })).body.phase.id;
    const p2 = (await w.a("POST", `/spaces/${id}/phases`, { name: "Two" })).body.phase.id;
    await w.a("POST", `/spaces/${id}/tasks`, { name: "G", phase_id: p1, gate: true });
    expect((await w.b("POST", `/spaces/${id}/phases/${p2}/unlock`)).status).toBe(403);
    const unlocked = await w.a("POST", `/spaces/${id}/phases/${p2}/unlock`);
    expect(unlocked.body.phase.locked).toBe(false);
    expect(await actionsOf(w)).toContain("phase.unlocked_manually");
  });

  it("reorders and removes phases, moving tasks to no phase", async () => {
    const w = await world();
    const id = await room(w);
    const one = (await w.a("POST", `/spaces/${id}/phases`, { name: "One" })).body.phase.id;
    const two = (await w.a("POST", `/spaces/${id}/phases`, { name: "Two" })).body.phase.id;
    const three = (
      await w.a("POST", `/spaces/${id}/phases`, { name: "Three", after_phase_id: one })
    ).body.phase.id;
    const namesOf = async () =>
      (await w.a("GET", `/spaces/${id}/phases`)).body.phases.map((p: { name: string }) => p.name);
    expect(await namesOf()).toEqual(["One", "Three", "Two"]);
    await w.a("PATCH", `/spaces/${id}/phases/${two}`, { ordinal: 1 });
    expect(await namesOf()).toEqual(["Two", "One", "Three"]);
    const task = (await w.a("POST", `/spaces/${id}/tasks`, { name: "T", phase_id: three })).body
      .task;
    expect((await w.a("DELETE", `/spaces/${id}/phases/${three}`)).status).toBe(204);
    expect((await w.a("GET", `/tasks/${task.id}`)).body.task.phase_id).toBeNull();
    const ordinals = (await w.a("GET", `/spaces/${id}/phases`)).body.phases.map(
      (p: { ordinal: number }) => p.ordinal,
    );
    expect(ordinals).toEqual([1, 2]);
  });

  it("does not let a collaborator open the next phase by cancelling or moving the gate", async () => {
    const w = await world();
    const id = await room(w);
    const p1 = (await w.a("POST", `/spaces/${id}/phases`, { name: "One" })).body.phase.id;
    const p2 = (await w.a("POST", `/spaces/${id}/phases`, { name: "Two" })).body.phase.id;
    const gate = (await w.a("POST", `/spaces/${id}/tasks`, { name: "G", phase_id: p1, gate: true }))
      .body.task;
    expect((await w.b("PATCH", `/tasks/${gate.id}`, { status: "cancelled" })).status).toBe(403);
    expect((await w.b("PATCH", `/tasks/${gate.id}`, { phase_id: p2 })).status).toBe(403);
    expect((await w.b("PATCH", `/tasks/${gate.id}`, { phase_id: null })).status).toBe(403);
    expect((await w.a("GET", `/spaces/${id}/phases`)).body.phases[1].locked).toBe(true);
  });

  it("refuses to start a run in a locked phase", async () => {
    const w = await world();
    const id = await room(w);
    const p1 = (await w.a("POST", `/spaces/${id}/phases`, { name: "One" })).body.phase.id;
    const p2 = (await w.a("POST", `/spaces/${id}/phases`, { name: "Two" })).body.phase.id;
    await w.a("POST", `/spaces/${id}/tasks`, { name: "G", phase_id: p1, gate: true });
    const res = await w.a("POST", `/spaces/${id}/tasks`, {
      name: "Locked",
      phase_id: p2,
      assignee: { type: "assistant" },
    });
    expect(res.body.code).toBe("PHASE_LOCKED");
    expect(w.runs.runs).toHaveLength(0);
  });

  it("does not let a collaborator reopen an approved task", async () => {
    const w = await world();
    const id = await room(w);
    const p1 = (await w.a("POST", `/spaces/${id}/phases`, { name: "One" })).body.phase.id;
    const gate = (await w.a("POST", `/spaces/${id}/tasks`, { name: "G", phase_id: p1, gate: true }))
      .body.task;
    await w.a("PATCH", `/tasks/${gate.id}`, { status: "done" });
    expect((await w.b("PATCH", `/tasks/${gate.id}`, { status: "todo" })).status).toBe(403);
    const reopened = await w.a("PATCH", `/tasks/${gate.id}`, { status: "todo" });
    expect(reopened.body.task.approved_at).toBeNull();
  });

  it("filters to my tasks and exports CSV with formulas neutralised", async () => {
    const w = await world();
    const id = await room(w);
    await w.a("POST", `/spaces/${id}/tasks`, {
      name: '=HYPERLINK("x")',
      assignee: { type: "user", user_id: w.ben.userId },
    });
    await w.a("POST", `/spaces/${id}/tasks`, { name: "Plain" });
    const mine = (await w.b("GET", `/spaces/${id}/tasks?filter[assignee]=me`)).body.tasks;
    expect(mine).toHaveLength(1);
    const csv = (await w.b("GET", `/spaces/${id}/tasks/export`)).body as string;
    expect(csv.split("\r\n")[0]).toBe("Task,Phase,Status,Assignee,Due,Gate,Awaiting approval");
    expect(csv).toContain("'=HYPERLINK");
    expect((await w.c("GET", `/spaces/${id}/tasks/export`)).status).toBe(404);
  });

  it("enforces mention, edit and delete rules on comments", async () => {
    const w = await world();
    const id = await room(w);
    const task = (await w.a("POST", `/spaces/${id}/tasks`, { name: "T" })).body.task;
    // Cal isn't in the Space, so can't be mentioned.
    const bad = await w.a("POST", `/tasks/${task.id}/comments`, {
      body_md: "cc @cal",
      mentions: [w.cal.userId],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("MENTION_NOT_VISIBLE");
    const ok = await w.a("POST", `/tasks/${task.id}/comments`, {
      body_md: "cc @ben",
      mentions: [w.ben.userId],
    });
    expect(ok.status).toBe(201);
    expect(w.events.find((e) => e.kind === "mention")?.userIds).toEqual([w.ben.userId]);
    // Only its author edits.
    const theirs = await w.b("PATCH", `/tasks/${task.id}/comments/${ok.body.comment.id}`, {
      body_md: "hi",
    });
    expect(theirs.status).toBe(403);
    const edited = await w.a("PATCH", `/tasks/${task.id}/comments/${ok.body.comment.id}`, {
      body_md: "cc ben",
    });
    expect(edited.body.comment.edited_at).toBeTruthy();
    // An admin may delete anyone's: a tombstone remains.
    const mine = (await w.b("POST", `/tasks/${task.id}/comments`, { body_md: "Done soon" })).body
      .comment;
    expect((await w.a("DELETE", `/tasks/${task.id}/comments/${mine.id}`)).status).toBe(204);
    const list = (await w.a("GET", `/tasks/${task.id}/comments`)).body.comments;
    expect(list.find((c: { id: string }) => c.id === mine.id)).toMatchObject({
      deleted: true,
      body_md: null,
    });
    // The feed never carries a comment's words.
    const feed = JSON.stringify((await w.a("GET", `/spaces/${id}/activity`)).body);
    expect(feed).not.toContain("Done soon");
  });

  it("closes the edit window after 15 minutes", async () => {
    const w = await world();
    const id = await room(w);
    const task = (await w.a("POST", `/spaces/${id}/tasks`, { name: "T" })).body.task;
    const c = (await w.a("POST", `/tasks/${task.id}/comments`, { body_md: "first" })).body.comment;
    await pool.query(
      "update work.task_comment set created_at = now() - interval '16 minutes' where id = $1",
      [c.id],
    );
    const late = await w.a("PATCH", `/tasks/${task.id}/comments/${c.id}`, { body_md: "second" });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("EDIT_WINDOW_CLOSED");
  });
});

describe("templates", () => {
  it("builds a Space from a saved Space: tasks come back unassigned and undated", async () => {
    const w = await world();
    const id = await room(w, "Source deal");
    const p1 = (await w.a("POST", `/spaces/${id}/phases`, { name: "Diligence" })).body.phase.id;
    const p2 = (await w.a("POST", `/spaces/${id}/phases`, { name: "Signing" })).body.phase.id;
    await w.a("POST", `/spaces/${id}/phases`, { name: "Closing" });
    await shareAgent(w, id);
    for (let i = 0; i < 5; i += 1) {
      await w.a("POST", `/spaces/${id}/tasks`, {
        name: `D${i}`,
        phase_id: p1,
        due_at: "2026-12-01",
        ...(i < 2 ? { assignee: { type: "user", user_id: w.ben.userId } } : {}),
      });
    }
    await w.a("POST", `/spaces/${id}/tasks`, { name: "Sign-off", phase_id: p2, gate: true });
    await w.a("PUT", `/spaces/${id}/context`, {
      parties: [{ name: "Secret Party", role: "buyer" }],
      key_dates: [],
    });
    await w.a("PATCH", `/spaces/${id}`, {
      customization: { accent_color: "#336699", welcome_md: "Welcome!" },
    });

    // Ben holds no spaces.templates permission.
    expect(
      (await w.b("POST", "/space-templates", { name: "T", from_space_id: id })).body.code,
    ).toBe("FORBIDDEN");
    const saved = await w.a("POST", "/space-templates", {
      name: "Deal template",
      from_space_id: id,
    });
    expect(saved.status).toBe(201);
    const def = saved.body.template.definition;
    expect(def.phases.map((p: { name: string }) => p.name)).toEqual([
      "Diligence",
      "Signing",
      "Closing",
    ]);
    expect(def.agents).toEqual([{ id: w.agentId, level: "run" }]);
    // Nothing about people, context or content.
    expect(JSON.stringify(def)).not.toContain("Secret Party");
    expect(JSON.stringify(def)).not.toContain("Welcome!");

    const made = await w.a("POST", "/spaces", {
      name: "Next deal",
      template_id: saved.body.template.id,
    });
    expect(made.status).toBe(201);
    expect(made.body.skipped).toEqual([]);
    const next = made.body.space;
    expect(next.template_id).toBe(saved.body.template.id);
    expect(next.context.parties).toEqual([]);
    expect(next.customization.accent_color).toBe("#336699");
    expect(next.customization.welcome_md).toBeUndefined();
    expect((await w.a("GET", `/spaces/${next.id}/phases`)).body.phases).toHaveLength(3);
    const tasks = (await w.a("GET", `/spaces/${next.id}/tasks`)).body.tasks;
    expect(tasks).toHaveLength(6);
    expect(
      tasks.every(
        (t: { assignee: unknown; due_at: unknown }) => t.assignee === null && t.due_at === null,
      ),
    ).toBe(true);
    expect(tasks.filter((t: { gate: boolean }) => t.gate)).toHaveLength(1);
    const resources = (await w.a("GET", `/spaces/${next.id}/resources`)).body.resources;
    expect(resources).toMatchObject([{ resource_type: "agent", access: "run" }]);
    expect(await actionsOf(w)).toContain("space.template_applied");
  });

  it("skips what the creator can't use, and says a wall is why", async () => {
    const w = await world();
    const walled = await matter(w.ana, "allow_list", "W-1");
    // Only Ana is on the allow-list.
    await pool.query(
      `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
       values ($1, $2, 'user', $3, 'allow')`,
      [w.ana.workspaceId, walled, w.ana.userId],
    );
    const behindWall = await vault(w.ana, w.ana.userId, walled);
    const anas = await vault(w.ana, w.ana.userId);
    const nobody = await uuid7();
    const saved = await w.a("POST", "/space-templates", {
      name: "With vaults",
      shared_to: { workspace: true, group_ids: [] },
      definition: {
        schema: "counsel.space-template/1",
        phases: [],
        vault_links: [{ id: behindWall }, { id: anas }, { id: nobody }],
      },
    });
    expect(saved.status).toBe(201);
    // Ben can use a shared template but can't change it.
    const rename = await w.b("PATCH", `/space-templates/${saved.body.template.id}`, {
      name: "Mine",
    });
    expect(rename.status).toBe(403);

    // Ana can reach the first two, so only the unknown id is skipped.
    const forAna = await w.a("POST", "/spaces", {
      name: "Ana's deal",
      template_id: saved.body.template.id,
    });
    expect(forAna.body.skipped).toEqual([{ kind: "vault", id: nobody, reason: "not_found" }]);

    // Ben is walled from the first and has no access to the second.
    const forBen = await w.b("POST", "/spaces", {
      name: "Ben's deal",
      template_id: saved.body.template.id,
    });
    expect(forBen.status).toBe(201);
    const reasons = Object.fromEntries(
      forBen.body.skipped.map((s: { id: string; reason: string }) => [s.id, s.reason]),
    );
    expect(reasons).toEqual({ [behindWall]: "wall", [anas]: "not_found", [nobody]: "not_found" });
    const resources = (await w.b("GET", `/spaces/${forBen.body.space.id}/resources`)).body
      .resources;
    expect(resources).toEqual([]);
  });

  it("keeps a template saved from a matter's Space behind that matter's wall", async () => {
    const w = await world();
    const m = await matter(w.ana, "open", "T-1");
    const made = await w.a("POST", "/spaces", { name: "Matter source", matter_id: m });
    await w.a("POST", `/spaces/${made.body.space.id}/phases`, { name: "Secret phase" });
    const saved = await w.a("POST", "/space-templates", {
      name: "From a matter",
      from_space_id: made.body.space.id,
      shared_to: { workspace: true, group_ids: [] },
    });
    expect((await w.b("GET", "/space-templates")).body.templates).toHaveLength(1);
    await pool.query(
      `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
       values ($1, $2, 'user', $3, 'deny')`,
      [w.ana.workspaceId, m, w.ben.userId],
    );
    expect((await w.b("GET", "/space-templates")).body.templates).toHaveLength(0);
    expect((await w.b("GET", `/space-templates/${saved.body.template.id}`)).status).toBe(404);
  });

  it("is private to its owner until shared, and applies to an existing Space additively", async () => {
    const w = await world();
    const saved = await w.a("POST", "/space-templates", {
      name: "Private",
      definition: { schema: "counsel.space-template/1", phases: [{ name: "One", tasks: [] }] },
    });
    const tid = saved.body.template.id;
    expect((await w.b("GET", `/space-templates/${tid}`)).status).toBe(404);
    expect((await w.b("GET", "/space-templates")).body.templates).toHaveLength(0);
    await w.a("PATCH", `/space-templates/${tid}`, {
      shared_to: { workspace: true, group_ids: [] },
    });
    expect((await w.b("GET", "/space-templates")).body.templates).toHaveLength(1);
    const id = await room(w);
    await w.a("POST", `/spaces/${id}/phases`, { name: "Existing" });
    const applied = await w.a("POST", `/spaces/${id}/apply-template`, { template_id: tid });
    expect(applied.status).toBe(200);
    const names = (await w.a("GET", `/spaces/${id}/phases`)).body.phases.map(
      (p: { name: string }) => p.name,
    );
    expect(names).toEqual(["Existing", "One"]);
  });
});

describe("Work in", () => {
  it("shows a Space locked to someone the matter admits, and lets them ask to join", async () => {
    const w = await world();
    const m = await matter(w.ana, "open", "WI-1");
    const made = await w.a("POST", "/spaces", { name: "Matter room", matter_id: m });
    const id: string = made.body.space.id;

    // Picking the matter before they are in: the matter only, no Space, locked.
    const picked = await w.b("GET", `/work-in?matter_id=${m}`);
    expect(picked.body).toEqual({ matter_id: m, space_id: null, locked: true });
    const listed = (await w.b("GET", "/spaces/directory")).body.spaces;
    expect(listed.find((s: { id: string }) => s.id === id)).toMatchObject({ locked: true });

    const asked = await w.b("POST", `/spaces/${id}/access-requests`, { message: "Please add me" });
    expect(asked.status).toBe(201);
    expect(w.events.find((e) => e.kind === "space.access_requested")?.userIds).toEqual([
      w.ana.userId,
    ]);
    expect((await w.b("POST", `/spaces/${id}/access-requests`, {})).body.code).toBe(
      "ALREADY_REQUESTED",
    );
    // Only an admin reads the requests.
    expect((await w.b("GET", `/spaces/${id}/requests`)).status).toBe(404);
    const pending = (await w.a("GET", `/spaces/${id}/requests`)).body.access;
    expect(pending).toHaveLength(1);
    const accepted = await w.a("POST", `/spaces/${id}/access-requests/${pending[0].id}`, {
      decision: "accept",
    });
    expect(accepted.body.request.status).toBe("accepted");

    // Now they are in: matter and Space both set.
    const again = await w.b("GET", `/work-in?matter_id=${m}`);
    expect(again.body).toEqual({ matter_id: m, space_id: id, locked: false });
    expect((await w.b("GET", `/spaces/${id}`)).body.space.my_role).toBe("collaborator");
    expect((await w.b("POST", `/spaces/${id}/access-requests`, {})).body.code).toBe(
      "ALREADY_MEMBER",
    );
  });

  it("records a denial with its reason", async () => {
    const w = await world();
    const m = await matter(w.ana, "open", "WI-2");
    const made = await w.a("POST", "/spaces", { name: "Closed to Ben", matter_id: m });
    const id: string = made.body.space.id;
    await w.b("POST", `/spaces/${id}/access-requests`, {});
    const pending = (await w.a("GET", `/spaces/${id}/requests`)).body.access;
    const path = `/spaces/${id}/access-requests/${pending[0].id}`;
    expect((await w.a("POST", path, { decision: "deny" })).status).toBe(400);
    const denied = await w.a("POST", path, { decision: "deny", reason: "Not on the team" });
    expect(denied.body.request.status).toBe("denied");
    expect((await w.b("GET", `/spaces/${id}`)).status).toBe(404);
  });

  it("hides a Space whose matter walls the user, and 404s a request to join it", async () => {
    const w = await world();
    const walled = await matter(w.ana, "allow_list", "WI-3");
    await pool.query(
      `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
       values ($1, $2, 'user', $3, 'allow')`,
      [w.ana.workspaceId, walled, w.ana.userId],
    );
    const made = await w.a("POST", "/spaces", { name: "Walled room", matter_id: walled });
    const id: string = made.body.space.id;
    // Neither the matter nor the Space shows to Cal, and asking finds nothing.
    const listed = (await w.c("GET", "/spaces/directory")).body.spaces;
    expect(listed.map((s: { id: string }) => s.id)).not.toContain(id);
    expect((await w.c("GET", `/work-in?matter_id=${walled}`)).status).toBe(404);
    expect((await w.c("GET", `/work-in?space_id=${id}`)).status).toBe(404);
    expect((await w.c("POST", `/spaces/${id}/access-requests`, {})).status).toBe(404);
    expect((await w.c("GET", `/spaces/${id}`)).status).toBe(404);
  });

  it("goes dead the moment a wall changes: a member walled from the matter loses the Space", async () => {
    const w = await world();
    const m = await matter(w.ana, "open", "WI-4");
    const made = await w.a("POST", "/spaces", { name: "Open room", matter_id: m });
    const id: string = made.body.space.id;
    await w.a("POST", `/spaces/${id}/members`, {
      principal_type: "user",
      principal_id: w.ben.userId,
      role: "collaborator",
    });
    expect((await w.b("GET", `/spaces/${id}`)).status).toBe(200);
    await pool.query(
      `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
       values ($1, $2, 'user', $3, 'deny')`,
      [w.ana.workspaceId, m, w.ben.userId],
    );
    expect((await w.b("GET", `/spaces/${id}`)).status).toBe(404);
    expect((await w.b("GET", `/spaces/${id}/tasks`)).status).toBe(404);
  });

  it("adds a matter to a standalone Space once", async () => {
    const w = await world();
    const id = await room(w);
    const m = await matter(w.ana, "open", "WI-5");
    const attached = await w.a("PUT", `/spaces/${id}/matter`, { matter_id: m });
    expect(attached.body.space.matter.id).toBe(m);
    const m2 = await matter(w.ana, "open", "WI-6");
    expect((await w.a("PUT", `/spaces/${id}/matter`, { matter_id: m2 })).status).toBe(400);
  });
});
