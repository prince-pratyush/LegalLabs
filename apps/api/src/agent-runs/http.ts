import { RunSignal } from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { AgentRuns } from "./runs.js";

type Env = { Variables: { principal: Principal } };

const listQuery = z.object({
  kind: z.enum(["agent", "workflow", "agent_builder"]).optional(),
  subject_id: z.uuid().optional(),
  status: z.string().max(30).optional(),
  test_mode: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const notFound = (c: Context) =>
  c.json({ code: "NOT_FOUND", message: "That run wasn't found." }, 404);

const answered = (c: Context, result: "ok" | "FORBIDDEN" | "FINISHED") => {
  if (result === "ok") return c.body(null, 202);
  if (result === "FORBIDDEN") {
    return c.json({ code: "FORBIDDEN", message: "You can't control this run." }, 403);
  }
  return c.json({ code: "RUN_FINISHED", message: "That run has already finished." }, 409);
};

/** Run history and control (agents-workflows.md §5.3); the stream itself is /runs/{id}/events. */
export function agentRunHttp(runs: AgentRuns, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();

  app.get("/runs", async (c) => {
    const q = listQuery.safeParse({
      kind: c.req.query("filter[kind]") ?? c.req.query("kind"),
      subject_id: c.req.query("filter[subject_id]") ?? c.req.query("subject_id"),
      status: c.req.query("filter[status]") ?? c.req.query("status"),
      test_mode: c.req.query("test_mode"),
      limit: c.req.query("limit"),
    });
    if (!q.success) return c.json({ code: "INVALID_REQUEST", message: "Check the filters." }, 400);
    const { test_mode, ...rest } = q.data;
    const found = await runs.list(c.get("principal"), {
      ...rest,
      ...(test_mode ? { test_mode: test_mode === "true" } : {}),
    });
    return c.json({ runs: found });
  });

  app.get("/runs/:id/steps", async (c) => {
    const steps = await runs.steps(c.get("principal"), c.req.param("id"));
    return steps ? c.json({ steps }) : notFound(c);
  });

  app.get("/runs/:id/steps/:step", async (c) => {
    const step = await runs.step(c.get("principal"), c.req.param("id"), c.req.param("step"));
    return step ? c.json({ step }) : notFound(c);
  });

  // The same address cancels a thread's run. Marking one of these cancelled in the database
  // alone would leave it calling models and tools, so it goes through its engine; any other run
  // falls through to the thread routes mounted after this.
  app.post("/runs/:id/cancel", async (c, next) => {
    const result = await runs.signal(
      c.get("principal"),
      c.req.param("id"),
      { name: "cancel", reason: "cancelled" },
      clientOf(c),
    );
    if (result === "NOT_FOUND") return next();
    return answered(c, result);
  });

  app.post(
    "/runs/:id/signal",
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => c.json({ code: "TOO_LARGE", message: "That request is too large." }, 413),
    }),
    async (c) => {
      // The body is the signal itself: {"name": "cancel", "reason": "..."}.
      const parsed = RunSignal.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ code: "INVALID_REQUEST", message: "That isn't a run signal." }, 400);
      }
      const result = await runs.signal(
        c.get("principal"),
        c.req.param("id"),
        parsed.data,
        clientOf(c),
      );
      return result === "NOT_FOUND" ? notFound(c) : answered(c, result);
    },
  );

  return app;
}
