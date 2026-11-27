import {
  CiAgentCreate,
  CiAgentPatch,
  CiAssignRequest,
  CiReviewCreate,
  CiReviewStatus,
  CiStatusRequest,
} from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { Limiter } from "../auth/limiter.js";
import type { Ci, CiFailure } from "./ci.js";

type Env = { Variables: { principal: Principal } };
type Status = 400 | 403 | 404 | 409 | 422 | 429;

const FAILURES: Record<CiFailure, { status: Status; message: string }> = {
  NOT_FOUND: { status: 404, message: "That agent, review or document wasn't found." },
  FORBIDDEN: { status: 403, message: "You don't have access to do that." },
  NOT_PUBLISHED: { status: 422, message: "Publish the playbook first." },
  AGENT_NOT_LIVE: { status: 409, message: "Activate the review agent first." },
  ASSIGNEE_NOT_ALLOWED: {
    status: 422,
    message: "That person can't open this contract and its review.",
  },
  WRONG_STATE: { status: 409, message: "That review isn't in a state that allows this." },
  TOO_MANY_REQUESTS: { status: 429, message: "You've asked a lot just now. Try again shortly." },
  BAD_CURSOR: { status: 400, message: "Check the request." },
};

const Filter = z.object({
  status: CiReviewStatus.optional(),
  assigneeId: z.union([z.literal("me"), z.uuid()]).optional(),
  agentId: z.uuid().optional(),
  cursor: z.string().max(200).optional(),
});

export function ciHttp(ci: Ci, clientOf: (c: Context) => Client, asks?: Limiter) {
  const app = new Hono<Env>();
  const limitBody = bodyLimit({
    maxSize: 128 * 1024,
    onError: (c) => c.json({ code: "TOO_LARGE", message: "That request is too large." }, 413),
  });

  const fail = (c: Context, reason: CiFailure) => {
    const f = FAILURES[reason];
    return c.json({ code: reason, message: f.message }, f.status);
  };
  const invalid = (c: Context, error?: z.ZodError) =>
    c.json(
      {
        code: "INVALID_REQUEST",
        message: "Check the request.",
        details: error?.issues.slice(0, 20).map((i) => ({ path: i.path, code: i.code })) ?? [],
      },
      400,
    );
  async function parse<T extends z.ZodType>(c: Context, schema: T) {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    return parsed.success
      ? { data: parsed.data as z.output<T> }
      : { response: invalid(c, parsed.error) };
  }

  // A review spends model calls, from the same budget as thread questions.
  const charging = (userId: string) => {
    const spent = { wait: 0 };
    const charge = (n: number) => {
      for (let i = 0; i < n && spent.wait === 0; i++) spent.wait = asks?.take(userId) ?? 0;
      return spent.wait;
    };
    return { spent, charge };
  };

  app.post("/apps/ci/agents", limitBody, async (c) => {
    const body = await parse(c, CiAgentCreate);
    if (!("data" in body)) return body.response;
    const result = await ci.createAgent(c.get("principal"), body.data, clientOf(c));
    return result.ok ? c.json({ agent: result.value }, 201) : fail(c, result.reason);
  });

  app.get("/apps/ci/agents", async (c) =>
    c.json({ agents: await ci.listAgents(c.get("principal")) }),
  );

  app.get("/apps/ci/agents/:id", async (c) => {
    const agent = await ci.getAgent(c.get("principal"), c.req.param("id"));
    return agent ? c.json({ agent }) : fail(c, "NOT_FOUND");
  });

  app.patch("/apps/ci/agents/:id", limitBody, async (c) => {
    const body = await parse(c, CiAgentPatch);
    if (!("data" in body)) return body.response;
    const result = await ci.patchAgent(
      c.get("principal"),
      c.req.param("id"),
      body.data,
      clientOf(c),
    );
    return result.ok ? c.json({ agent: result.value }) : fail(c, result.reason);
  });

  for (const [path, status] of [
    ["activate", "live"],
    ["deactivate", "paused"],
  ] as const) {
    app.post(`/apps/ci/agents/:id/${path}`, async (c) => {
      const id = c.req.param("id") ?? "";
      const result = await ci.setAgentStatus(c.get("principal"), id, status, clientOf(c));
      return result.ok ? c.json({ agent: result.value }) : fail(c, result.reason);
    });
  }

  app.post("/apps/ci/reviews", limitBody, async (c) => {
    const body = await parse(c, CiReviewCreate);
    if (!("data" in body)) return body.response;
    const { spent, charge } = charging(c.get("principal").userId);
    const result = await ci.createReview(c.get("principal"), body.data, charge, clientOf(c));
    if (spent.wait > 0) c.header("Retry-After", String(spent.wait));
    return result.ok ? c.json(result.value, 201) : fail(c, result.reason);
  });

  app.get("/apps/ci/reviews", async (c) => {
    const query = Filter.safeParse({
      status: c.req.query("filter[status]") || undefined,
      assigneeId: c.req.query("filter[assignee_id]") || undefined,
      agentId: c.req.query("filter[agent_id]") || undefined,
      cursor: c.req.query("cursor") || undefined,
    });
    if (!query.success) return invalid(c, query.error);
    const me = c.get("principal");
    const { assigneeId, ...filter } = query.data;
    const result = await ci.list(me, {
      ...filter,
      assigneeId: assigneeId === "me" ? me.userId : assigneeId,
    });
    return result.ok ? c.json(result.value) : fail(c, result.reason);
  });

  app.get("/apps/ci/reviews/:id", async (c) => {
    const review = await ci.get(c.get("principal"), c.req.param("id"));
    return review ? c.json({ review }) : fail(c, "NOT_FOUND");
  });

  app.post("/apps/ci/reviews/:id/assign", limitBody, async (c) => {
    const body = await parse(c, CiAssignRequest);
    if (!("data" in body)) return body.response;
    const result = await ci.assign(
      c.get("principal"),
      c.req.param("id"),
      body.data.assignee_id,
      clientOf(c),
    );
    return result.ok ? c.json({ review: result.value }) : fail(c, result.reason);
  });

  const rerun = async (c: Context<Env>, id: string) => {
    const { spent, charge } = charging(c.get("principal").userId);
    const result = await ci.rerun(c.get("principal"), id, charge, clientOf(c));
    if (spent.wait > 0) c.header("Retry-After", String(spent.wait));
    return result.ok ? c.json(result.value, 202) : fail(c, result.reason);
  };

  app.post("/apps/ci/reviews/:id/rerun", async (c) => rerun(c, c.req.param("id")));

  app.post("/apps/ci/reviews/:id/status", limitBody, async (c) => {
    const body = await parse(c, CiStatusRequest);
    if (!("data" in body)) return body.response;
    const id = c.req.param("id");
    if (body.data.status === "queued") return rerun(c, id);
    const result = await ci.markDone(c.get("principal"), id, clientOf(c));
    return result.ok ? c.json({ review: result.value }) : fail(c, result.reason);
  });

  return app;
}
