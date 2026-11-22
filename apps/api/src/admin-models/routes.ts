import {
  ConnectorInput,
  LocalEndpointInput,
  ModelConfigPatch,
  ModelKeyInput,
  ModelPolicy,
  ToolPolicyInput,
  UserToolPolicyInput,
} from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { AdminConnectors, ConnectorFailure } from "./connectors.js";
import type { AdminModels, ModelFailure } from "./models.js";

type Env = { Variables: { principal: Principal } };
type Status = 400 | 403 | 404 | 409 | 422 | 503;

const FAILURES: Record<ModelFailure | ConnectorFailure, { status: Status; message: string }> = {
  FORBIDDEN: { status: 403, message: "That needs the admin.config permission." },
  NOT_FOUND: { status: 404, message: "That wasn't found." },
  KEY_STORAGE_UNAVAILABLE: {
    status: 503,
    message: "This deployment has no secret key configured, so keys can't be stored.",
  },
  INVALID_REGION: { status: 422, message: "A local model must be zero data retention." },
  INVALID_URL: { status: 422, message: "Use a public https address." },
  DUPLICATE_NAME: { status: 409, message: "A connector with that name already exists." },
  DISCOVERY_FAILED: { status: 422, message: "The server didn't return a tool list." },
  NO_TOOLS_DISCOVERED: { status: 422, message: "Discover the server's tools first." },
  NO_TOOL_ALLOWED: { status: 422, message: "Allow or ask for at least one tool before approving." },
  POLICY_TIGHTEN_ONLY: {
    status: 422,
    message: "You can make a tool stricter for yourself, not looser than the workspace.",
  },
};

const small = bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) =>
    c.json({ code: "INVALID_REQUEST", message: "Check the details and try again." }, 400),
});
const id = z.uuid();

/** Admin Models and Connectors (ADM-005/006) plus the user-facing pieces that read them. */
export function adminModelRoutes(
  models: AdminModels,
  connectors: AdminConnectors,
  clientOf: (c: Context) => Client,
) {
  const app = new Hono<Env>();
  const bad = (c: Context) =>
    c.json({ code: "INVALID_REQUEST", message: "Check the details and try again." }, 400);
  const fail = (c: Context, reason: ModelFailure | ConnectorFailure) => {
    const f = FAILURES[reason];
    return c.json({ code: reason, message: f.message }, f.status);
  };
  const out = <T>(
    c: Context,
    r: { ok: true; value: T } | { ok: false; reason: ModelFailure | ConnectorFailure },
    status: 200 | 201 = 200,
  ) => (r.ok ? c.json(r.value as object, status) : fail(c, r.reason));
  const body = async <T>(c: Context, schema: z.ZodType<T>) => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  };
  const who = (c: Context<Env>) => c.get("principal");
  const modelKey = (c: Context<Env>) =>
    [c.req.param("provider") ?? "", c.req.param("model") ?? ""] as const;

  app.get("/admin/models", async (c) => out(c, await models.list(who(c))));
  app.get("/admin/roles", async (c) => {
    const r = await models.roles(who(c));
    return r.ok ? c.json({ items: r.value }) : fail(c, r.reason);
  });
  app.put("/admin/model-policy", small, async (c) => {
    const b = await body(c, ModelPolicy);
    return b ? out(c, await models.setPolicy(who(c), b, clientOf(c))) : bad(c);
  });
  app.post("/admin/models/local", small, async (c) => {
    const b = await body(c, LocalEndpointInput);
    return b ? out(c, await models.addLocal(who(c), b, clientOf(c)), 201) : bad(c);
  });
  app.patch("/admin/models/:provider/:model", small, async (c) => {
    const b = await body(c, ModelConfigPatch);
    const [provider, model] = modelKey(c);
    return b ? out(c, await models.patch(who(c), provider, model, b, clientOf(c))) : bad(c);
  });
  app.put("/admin/models/:provider/:model/key", small, async (c) => {
    const b = await body(c, ModelKeyInput);
    const [provider, model] = modelKey(c);
    return b ? out(c, await models.setKey(who(c), provider, model, b.key, clientOf(c))) : bad(c);
  });
  app.delete("/admin/models/:provider/:model/key", async (c) => {
    const [provider, model] = modelKey(c);
    return out(c, await models.clearKey(who(c), provider, model, clientOf(c)));
  });
  app.post("/admin/models/:provider/:model/test", async (c) => {
    const [provider, model] = modelKey(c);
    return out(c, await models.test(who(c), provider, model));
  });
  // What the caller may pick; empty when their role has the selector turned off.
  app.get("/models/allowed", async (c) => c.json(await models.allowedFor(who(c))));

  app.get("/admin/connectors", async (c) => c.json({ items: await connectors.list(who(c)) }));
  app.post("/admin/connectors", small, async (c) => {
    const b = await body(c, ConnectorInput);
    return b ? out(c, await connectors.register(who(c), b, clientOf(c)), 201) : bad(c);
  });
  const cid = (c: Context<Env>) => {
    const p = id.safeParse(c.req.param("id"));
    return p.success ? p.data : null;
  };
  app.post("/admin/connectors/:id/discover", async (c) => {
    const i = cid(c);
    return i ? out(c, await connectors.discover(who(c), i, clientOf(c))) : bad(c);
  });
  app.put("/admin/connectors/:id/tools/:tool/policy", small, async (c) => {
    const i = cid(c);
    const b = await body(c, ToolPolicyInput);
    return i && b
      ? out(
          c,
          await connectors.setToolPolicy(who(c), i, c.req.param("tool"), b.policy, clientOf(c)),
        )
      : bad(c);
  });
  app.post("/admin/connectors/:id/approve", async (c) => {
    const i = cid(c);
    return i ? out(c, await connectors.approve(who(c), i, clientOf(c))) : bad(c);
  });
  app.post("/admin/connectors/:id/disable", async (c) => {
    const i = cid(c);
    return i ? out(c, await connectors.disable(who(c), i, clientOf(c))) : bad(c);
  });
  app.put("/connectors/:id/tools/:tool/my-policy", small, async (c) => {
    const i = cid(c);
    const b = await body(c, UserToolPolicyInput);
    return i && b
      ? out(
          c,
          await connectors.setUserPolicy(who(c), i, c.req.param("tool"), b.policy, clientOf(c)),
        )
      : bad(c);
  });
  return app;
}
