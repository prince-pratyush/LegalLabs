import { WebMatterSwitch, WebSearchSwitch } from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { WebAdminResult, WebSources } from "./sources.js";

type Env = { Variables: { principal: Principal } };

const FAILURES: Record<
  Exclude<WebAdminResult, "ok">,
  { status: 403 | 404 | 409; message: string }
> = {
  FORBIDDEN: { status: 403, message: "You don't have access to do that." },
  NOT_CONFIGURED: {
    status: 409,
    message: "No search service is set up for this installation.",
  },
  NOT_FOUND: { status: 404, message: "That matter wasn't found." },
};

export function webSearchHttp(web: WebSources, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();
  const json = bodyLimit({
    maxSize: 4 * 1024,
    onError: (c) => c.json({ code: "INVALID_REQUEST", message: "The request is too large." }, 400),
  });
  const invalid = (c: Context) =>
    c.json({ code: "INVALID_REQUEST", message: "Check the request." }, 400);
  const reply = (c: Context, result: WebAdminResult) => {
    if (result === "ok") return c.body(null, 204);
    const { status, message } = FAILURES[result];
    return c.json({ code: result, message }, status);
  };

  app.get("/web-search/settings", async (c) => c.json(await web.settings(c.get("principal"))));

  app.put("/web-search/settings", json, async (c) => {
    const parsed = WebSearchSwitch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    return reply(c, await web.setEnabled(c.get("principal"), parsed.data.enabled, clientOf(c)));
  });

  app.put("/web-search/matters/:id", json, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    const parsed = WebMatterSwitch.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !parsed.success) return invalid(c);
    return reply(
      c,
      await web.setMatter(c.get("principal"), id.data, parsed.data.blocked, clientOf(c)),
    );
  });

  return app;
}
