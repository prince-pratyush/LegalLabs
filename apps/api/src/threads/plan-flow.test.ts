import type { ModelProvider } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { auditTrail, testPool } from "../test-db.js";
import { matterHarness } from "../test-matters.js";

const pool = testPool();
afterAll(() => pool.end());

const QUESTION = { text: "Which party?", options: ["Landlord", "Tenant"], allow_text: true };
let plan = "";
let calls: { planner: boolean; text: string }[] = [];
const model: ModelProvider = {
  complete: async ({ messages }) => {
    const planner = messages[0]?.content.startsWith("You plan how") === true;
    calls.push({ planner, text: messages.map((m) => m.content).join("\n") });
    return {
      text: planner ? plan : 'Rent is due monthly.<c doc="D1" page="1" quote="Rent is due"/>',
      usage: { input_tokens: 500, output_tokens: 60 },
    };
  },
};
const h = matterHarness(pool, { anthropic: model });

async function started(content = "/plan draft a memo", extra: object = {}, question = true) {
  plan = JSON.stringify({
    steps: ["Read the lease", "Draft the memo"],
    ...(question ? { question: QUESTION } : {}),
  });
  calls = [];
  const ana = await h.workspace();
  const file = await h.postFile(ana, "/documents", "lease.txt", "Rent is due monthly.");
  await h.drain(ana);
  const res = await h.call(ana, "POST", "/threads", {
    content,
    scope: { document_ids: [file.body.document.id] },
    ...extra,
  });
  expect(res.status).toBe(202);
  await h.threads.threads.settled();
  const runId = res.body.run_id as string;
  const events = () =>
    h.threads.log.replay({ userId: ana.userId, workspaceId: ana.workspaceId } as never, runId, 0);
  const run = async () => (await h.call(ana, "GET", `/runs/${runId}`)).body.run;
  const post = async (path: string, body?: unknown) => {
    const out = await h.call(ana, "POST", `/runs/${runId}/${path}`, body);
    await h.threads.threads.settled();
    return out.status;
  };
  return { ana, runId, threadId: res.body.thread_id as string, events, run, post };
}

describe("plan mode", () => {
  it("shows a plan before any token, and re-plans on request", async () => {
    const r = await started();
    expect(await r.run()).toMatchObject({ status: "awaiting_approval", kind: "thread" });
    const first = await r.events();
    expect(first.map((e) => e.type)).toEqual(["status", "plan", "status"]);
    expect(calls).toHaveLength(1);
    // The command is for the app; the planner sees the request and the file's name only.
    expect(calls[0]?.text).toContain("Request: draft a memo");
    expect(calls[0]?.text).not.toContain("Rent is due");
    expect(JSON.stringify((await r.run()).plan)).not.toContain("scope");

    plan = JSON.stringify({ steps: ["Read the lease", "List the dates", "Draft the memo"] });
    expect(await r.post("plan/edit", { instruction: "List the dates first" })).toBe(202);
    expect((await r.run()).plan.steps).toHaveLength(3);
    expect(calls.at(-1)?.text).toContain("List the dates first");
    expect(await r.run()).toMatchObject({ status: "awaiting_approval" });
  });

  it("asks its question after approval, and carries on when it is skipped", async () => {
    const r = await started();
    expect(await r.post("approve")).toBe(202);
    expect(await r.run()).toMatchObject({ status: "awaiting_input" });
    expect((await r.events()).find((e) => e.type === "question")).toMatchObject({
      step_id: "q1",
      question: { text: "Which party?", allow_skip: true, allow_text: true },
    });
    expect(calls.filter((c) => !c.planner)).toHaveLength(0);

    expect(await r.post("answer", { question_id: "q1", skip: true, text: "x" })).toBe(400);
    expect(await r.post("answer", { question_id: "q1", option_id: "o9" })).toBe(400);
    expect(await r.post("answer", { question_id: "q2", skip: true })).toBe(409);
    expect(await r.post("answer", { question_id: "q1", skip: true })).toBe(202);

    expect(await r.run()).toMatchObject({ status: "done" });
    const events = await r.events();
    expect(events.find((e) => e.type === "step" && e.kind === "ask_user")).toMatchObject({
      status: "skipped",
      title: "You skipped the question",
    });
    expect(calls.at(-1)?.text).toContain("chose to skip it");
    expect(calls.at(-1)?.text).toContain("1. Read the lease\n2. Draft the memo");
    const types = events.map((e) => e.type);
    expect(types.indexOf("plan")).toBeLessThan(types.indexOf("token"));
    // Answering twice, or once it is done, does nothing.
    expect(await r.post("answer", { question_id: "q1", skip: true })).toBe(409);
    expect(await r.post("approve")).toBe(409);
  });

  it("passes the chosen option on, and keeps what was said out of the audit log", async () => {
    const r = await started();
    await r.post("approve");
    expect(await r.post("answer", { question_id: "q1", option_id: "o2" })).toBe(202);
    expect(calls.at(-1)?.text).toContain(
      'You asked "Which party?" and the person answered: Tenant',
    );
    const trail = await auditTrail(pool, r.ana.workspaceId);
    expect(trail.find((e) => e.action === "run.signal")?.details).toEqual({
      run_id: r.runId,
      skipped: false,
    });
    expect(JSON.stringify(trail)).not.toContain("Tenant");
    const thread = (await h.call(r.ana, "GET", `/threads/${r.threadId}`)).body.thread;
    expect(thread.messages[0].content).toBe("/plan draft a memo");
    expect(thread.title).toBe("draft a memo");
  });

  it("plans a list of several tasks unless told not to", async () => {
    const list = "- read\n- compare\n- list\n- draft";
    const planned = await started(list, {}, false);
    expect(await planned.run()).toMatchObject({ status: "awaiting_approval" });
    await planned.post("approve");
    expect(await planned.run()).toMatchObject({ status: "done" });
    const straight = await started(list, { plan_mode: false }, false);
    expect(await straight.run()).toMatchObject({ status: "done" });
    const forced = await started("What is the rent?", { plan_mode: true }, false);
    expect(await forced.run()).toMatchObject({ status: "awaiting_approval" });
    expect(await forced.post("cancel")).toBe(202);
    expect(await forced.post("approve")).toBe(409);
  });

  it("fails a run whose plan makes no sense, without answering", async () => {
    plan = "no";
    const ana = await h.workspace();
    const file = await h.postFile(ana, "/documents", "a.txt", "Rent is due monthly.");
    await h.drain(ana);
    calls = [];
    const res = await h.call(ana, "POST", "/threads", {
      content: "/plan go",
      scope: { document_ids: [file.body.document.id] },
    });
    await h.threads.threads.settled();
    const run = (await h.call(ana, "GET", `/runs/${res.body.run_id}`)).body.run;
    expect(run).toMatchObject({ status: "failed" });
    expect(calls).toHaveLength(1);
  });

  it("only lets the owner answer or approve", async () => {
    const r = await started();
    const other = await h.member(r.ana, "ben");
    for (const [path, body] of [
      ["approve", undefined],
      ["answer", { question_id: "q1", skip: true }],
    ] as const) {
      const res = await h.call(other, "POST", `/runs/${r.runId}/${path}`, body);
      expect(res.status).toBe(409);
    }
  });
});
