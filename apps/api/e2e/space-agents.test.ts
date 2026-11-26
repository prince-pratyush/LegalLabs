import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { type FakeMcp, PUBLIC_URL, startFakeMcp, TOKEN, writeTool } from "../src/test-mcp.js";
import { startFakeSmtp } from "../src/test-smtp.js";
import { until, useStack } from "./session.js";

/*
 * Agents in Spaces through the built server: its own catalogue, a task an agent completes and
 * returns, the approval an external Space needs, what its guest gets, and who may approve a
 * tool call from a run there. The model, the MCP server and the mail server are fakes.
 */

const SECRET = "Our walk-away price is nine million.";
const GUEST = "lead@other.test";

const model = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => {
    body += d;
  });
  req.on("end", () => {
    const sends =
      body.includes("Task: Send the note") && !body.includes("Call to vendor.send_mail");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "fake",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: sends
                ? 'TOOL: {"tool": "vendor.send_mail", "arguments": {"to": "a@vendor.test"}}'
                : "The supplier is sound.",
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
});

const smtp = await startFakeSmtp();
let mcp: FakeMcp;
const env: Record<string, string> = {
  LEGALLABS_SECRETS_KEY: randomBytes(32).toString("base64"),
  LEGALLABS_SMTP_HOST: "127.0.0.1",
  LEGALLABS_SMTP_PORT: String(smtp.port),
  LEGALLABS_SMTP_SECURITY: "none",
  LEGALLABS_MAIL_FROM: "no-reply@firm.test",
};
beforeAll(async () => {
  mcp = await startFakeMcp([writeTool("send_mail")]);
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  env.E2E_MCP_URL = mcp.url;
});
afterAll(async () => {
  await mcp?.close();
  await smtp.stop();
  model.closeAllConnections();
  model.close();
});

const { call, json, post, asOwner, workspace } = useStack({
  env,
  nodeArgs: ["--import", fileURLToPath(new URL("./mcp-preload.mjs", import.meta.url))],
  modelUrl: () => `http://127.0.0.1:${(model.address() as AddressInfo).port}`,
});

type Task = {
  id: string;
  status: string;
  assignee: { type: string; user_id?: string } | null;
  run: { id: string; status: string } | null;
  linked: { outputs: { kind: string; id: string }[] };
};
type Resource = { id: string; resource_type: string; resource_id: string; name: string | null };

/** Requests as someone other than the admin the stack signed in. */
const as = (cookie: string) => (path: string, body?: unknown) =>
  call(path, {
    headers: { cookie },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

/** A second member who may build agents and share outside, but administers nothing. */
async function colleague() {
  const email = `cal-${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(18).toString("hex");
  const [ws] = await asOwner<{ id: string }>("select id from core.workspace where slug = $1", [
    workspace(),
  ]);
  const [role] = await asOwner<{ id: string }>(
    "insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id",
    [
      ws?.id,
      email,
      ["threads.use", "agents.use", "agents.build", "spaces.external", "connectors.use"],
    ],
  );
  const [user] = await asOwner<{ id: string }>(
    `insert into core."user" (workspace_id, email, role_id, status)
     values ($1, $2, $3, 'active') returning id`,
    [ws?.id, email, role?.id],
  );
  await asOwner(
    "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
    [ws?.id, user?.id, await hashPassword(password)],
  );
  // Signed out, or signing in would end the admin's session.
  const res = await call("/auth/login", {
    method: "POST",
    headers: { cookie: "" },
    body: JSON.stringify({ workspace: workspace(), email, password }),
  });
  expect(res.status).toBe(200);
  return { id: user?.id ?? "", send: as(cookieOf(res)) };
}

async function agentBody(send: ReturnType<typeof as>, path: string, body: unknown, status: number) {
  const res = await send(path, body);
  expect(res.status, await res.clone().text()).toBe(status);
  // biome-ignore lint/suspicious/noExplicitAny: test responses are checked field by field
  return (await res.json()) as any;
}

/** An agent saved live, by whoever `send` is. */
async function saved(send: ReturnType<typeof as>, title: string, sources: unknown[] = []) {
  const made = await agentBody(send, "/api/v1/agents", { title, mode: "scratch" }, 201);
  const id: string = made.agent.id;
  await agentBody(
    send,
    `/api/v1/agents/${id}/versions`,
    { instructions: SECRET, sources, promote: true },
    201,
  );
  return id;
}

const returned = (task: string) =>
  until(
    async () => (await json<{ task: Task }>(`/api/v1/tasks/${task}`)).task,
    (t) => t.assignee?.type === "user",
    "the task to come back",
    60_000,
  );

describe("agents in Spaces on the composed server", () => {
  let admin: ReturnType<typeof as>;
  let cal: Awaited<ReturnType<typeof colleague>>;

  beforeAll(async () => {
    // The stack's own cookie goes with a request that names none.
    admin = (path, body) =>
      call(path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
    cal = await colleague();
  });

  it("completes a task given to an agent and hands it back", async () => {
    const agent = await saved(admin, "Supplier check");
    const { space } = await post<{ space: { id: string } }>(
      "/api/v1/spaces",
      { name: "Inside deal" },
      201,
    );
    const { resource } = await post<{ resource: Resource }>(
      `/api/v1/spaces/${space.id}/resources`,
      { resource_type: "agent", resource_id: agent, access: "run" },
      201,
    );
    expect(resource.name).toBe("Supplier check");
    const { task } = await post<{ task: Task }>(
      `/api/v1/spaces/${space.id}/tasks`,
      { name: "Check the supplier", assignee: { type: "agent", agent_id: agent } },
      201,
    );
    const done = await returned(task.id);
    expect(done.run?.status).toBe("done");
    expect(done.status).toBe("in_progress");
    expect(done.linked.outputs).toMatchObject([{ kind: "message" }]);
  });

  let space = "";
  let party = "";
  let guest: ReturnType<typeof as>;

  it("opens an external Space with an approved guest", async () => {
    space = (
      await post<{ space: { id: string } }>(
        "/api/v1/spaces",
        { name: "Outside deal", kind: "external" },
        201,
      )
    ).space.id;
    await post(
      `/api/v1/spaces/${space}/members`,
      { principal_type: "user", principal_id: cal.id, role: "collaborator" },
      201,
    );
    party = (
      await post<{ party: { id: string } }>(
        `/api/v1/spaces/${space}/parties`,
        { name: "Other LLP", domain: "other.test", connection_admin_emails: [GUEST] },
        201,
      )
    ).party.id;
    const { token } = await post<{ token: string }>(
      `/api/v1/spaces/${space}/guests`,
      { email: GUEST },
      201,
    );
    // The guest's own requests carry no member session.
    const anon = as("");
    expect((await anon("/guest/invites/accept", { token, name: "Lee" })).status).toBe(200);
    await call("/guest/login/code", {
      method: "POST",
      headers: { cookie: "" },
      body: JSON.stringify({ workspace: workspace(), email: GUEST }),
    });
    const mail = await until(
      async () => smtp.received.find((m) => m.to.includes(GUEST) && /is \d{8}/.test(m.data)),
      (m) => m !== undefined,
      "the code to arrive",
      20_000,
    );
    const verified = await anon("/guest/login/verify", {
      workspace: workspace(),
      email: GUEST,
      code: /is (\d{8})/.exec(mail?.data ?? "")?.[1],
    });
    expect(verified.status).toBe(200);
    guest = as(cookieOf(verified));
    await post(`/api/v1/spaces/${space}/parties/${party}/approve`, {});
    await agentBody(guest, `/api/v1/guest/spaces/${space}/connection/approve`, {}, 200);
  });

  let agent = "";

  it("holds a collaborator's share until a Space admin accepts it", async () => {
    const connector = await post<{ id: string }>(
      "/api/v1/admin/connectors",
      { name: "vendor", url: PUBLIC_URL, auth: { kind: "bearer", token: TOKEN } },
      201,
    );
    const base = `/api/v1/admin/connectors/${connector.id}`;
    await post(`${base}/discover`, {});
    await json(`${base}/tools/send_mail/policy`, {
      method: "PUT",
      body: JSON.stringify({ policy: "allow" }),
    });
    await post(`${base}/approve`, {});

    agent = await saved(cal.send, "Sender", [
      { label: "vendor", kind: "connector", source: "mcp:vendor" },
    ]);
    const asked = await agentBody(
      cal.send,
      `/api/v1/spaces/${space}/resources`,
      { resource_type: "agent", resource_id: agent, access: "run", per_party: { [party]: "run" } },
      202,
    );
    const early = await cal.send(`/api/v1/spaces/${space}/tasks`, {
      name: "Too soon",
      assignee: { type: "agent", agent_id: agent },
    });
    expect(((await early.json()) as { code: string }).code).toBe("AGENT_NOT_SHARED");
    const decide = `/api/v1/spaces/${space}/share-requests/${asked.request.id}`;
    expect((await cal.send(decide, { decision: "accept" })).status).toBe(403);
    expect((await guest(decide, { decision: "accept" })).status).toBe(403);

    const queue = await json<{ shares: { id: string; name: string }[] }>(
      `/api/v1/spaces/${space}/requests`,
    );
    expect(queue.shares).toMatchObject([{ id: asked.request.id, name: "Sender" }]);
    expect((await admin(decide, { decision: "accept" })).status).toBe(204);
  });

  it("gives the guest the agent's title and nothing of what is in it or from it", async () => {
    const seen = await guest(`/api/v1/guest/spaces/${space}`);
    const text = await seen.text();
    expect(JSON.parse(text).resources).toMatchObject([
      { resource_type: "agent", resource_id: agent, name: "Sender", access: "run" },
    ]);
    for (const hidden of ["walk-away", "mcp:vendor", "instructions", cal.id]) {
      expect(text).not.toContain(hidden);
    }
    for (const path of [
      `/api/v1/agents/${agent}`,
      `/api/v1/agents/${agent}/versions`,
      `/api/v1/agents/${agent}/export`,
      "/api/v1/runs",
      `/api/v1/spaces/${space}/tasks`,
      `/api/v1/spaces/${space}/resources`,
    ]) {
      expect((await guest(path)).status, path).toBe(403);
    }
    expect((await guest(`/api/v1/agents/${agent}/run`, { inputs: "hi" })).status).toBe(403);
  });

  it("leaves a tool call from a task there to the person whose run it is", async () => {
    const made = await agentBody(
      cal.send,
      `/api/v1/spaces/${space}/tasks`,
      { name: "Send the note", assignee: { type: "agent", agent_id: agent } },
      201,
    );
    const run: string = made.task.run.id;
    const waiting = await until(
      async () => {
        const res = await cal.send(`/api/v1/runs/${run}/steps`);
        const { steps } = (await res.json()) as { steps: { id: string; status: string }[] };
        return steps.find((s) => s.status === "awaiting_user");
      },
      (s) => s !== undefined,
      "the approval",
      60_000,
    );
    const approve = {
      name: "answer_question",
      step_id: waiting?.id,
      answer: { option_id: "approve" },
    };
    // The Space's admin, who is not the runner, can't approve it; nor can the guest.
    expect((await admin(`/api/v1/runs/${run}/signal`, approve)).status).toBe(404);
    expect((await guest(`/api/v1/runs/${run}/signal`, approve)).status).toBe(403);
    expect((await guest(`/api/v1/runs/${run}/events`)).status).toBe(403);
    expect(mcp.calls).toHaveLength(0);

    expect((await cal.send(`/api/v1/runs/${run}/signal`, approve)).status).toBe(202);
    const done = await until(
      async () => {
        const res = await cal.send(`/api/v1/tasks/${made.task.id}`);
        return ((await res.json()) as { task: Task }).task;
      },
      (t) => t.assignee?.type === "user",
      "the task to come back",
      60_000,
    );
    expect(done.run?.status).toBe("done");
    expect(mcp.calls.map((c) => c.name)).toEqual(["send_mail"]);
  });
});
