import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { Outcome, Reason, Retention } from "./service.js";

type Env = { Variables: { principal: Principal } };

const small = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) =>
    c.json({ code: "INVALID_REQUEST", message: "Check the details and try again." }, 400),
});

const Id = z.string().uuid();
const Scope = z.enum(["workspace", "vault", "matter"]);
const Hours = z.number().int().nullable();
const PolicyBody = z.object({
  scope: Scope,
  scope_id: Id.optional(),
  hours: Hours,
  confirm_slug: z.string().max(200).optional(),
  basis: z.enum(["upload", "access"]).optional(),
});
const HoldBody = z.object({
  object_type: z.enum(["thread", "document", "vault", "review_table", "matter"]),
  object_id: Id,
  held: z.boolean(),
  reason: z.string().max(500).optional(),
});

const FAILURES: Record<Reason, [400 | 403 | 404 | 409 | 422, string]> = {
  FORBIDDEN: [403, "You need retention admin access for that."],
  NOT_FOUND: [404, "That wasn't found."],
  RETENTION_MIN: [422, "Retention must be at least 3 hours."],
  CONFIRM_REQUIRED: [409, "This deletes over 1,000 items. Type the workspace slug to confirm."],
  NOT_RESTORABLE: [409, "That can no longer be restored."],
  HELD: [409, "That is under a hold and can't be purged."],
  VAULT_DELETED: [409, "Restore the vault first."],
  INVALID: [400, "Check the details and try again."],
};

export function retentionRoutes(retention: Retention, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();
  const base = "/admin/retention";

  const send = <T>(c: Context, outcome: Outcome<T>, status: 200 | 201 = 200) => {
    if (outcome.ok) return c.json(outcome.value as object, status);
    const [code, message] = FAILURES[outcome.reason];
    return c.json(
      {
        code: outcome.reason,
        message,
        ...(outcome.estimate ? { estimate: outcome.estimate } : {}),
      },
      code,
    );
  };
  const invalid = (c: Context) => send(c, { ok: false, reason: "INVALID" });
  const idOf = (c: Context) => {
    const id = Id.safeParse(c.req.param("id"));
    return id.success ? id.data : null;
  };

  app.get(base, async (c) => {
    const policies = await retention.policies(c.get("principal"));
    if (!policies.ok) return send(c, policies);
    return c.json({ ...policies.value, exemptions: retention.exemptions() });
  });

  app.get(`${base}/estimate`, async (c) => {
    const q = z
      .object({
        scope: Scope,
        scope_id: Id.optional(),
        hours: z.union([z.literal("unlimited"), z.coerce.number().int()]),
      })
      .safeParse(c.req.query());
    if (!q.success) return invalid(c);
    const p = c.get("principal");
    const scopeId = q.data.scope === "workspace" ? p.workspaceId : q.data.scope_id;
    if (!scopeId) return invalid(c);
    return send(
      c,
      await retention.estimate(
        p,
        q.data.scope,
        scopeId,
        q.data.hours === "unlimited" ? null : q.data.hours,
      ),
    );
  });

  app.put(`${base}/policy`, small, async (c) => {
    const body = PolicyBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const p = c.get("principal");
    const scopeId = body.data.scope === "workspace" ? p.workspaceId : body.data.scope_id;
    if (!scopeId) return invalid(c);
    return send(
      c,
      await retention.setPolicy(p, clientOf(c), {
        scope: body.data.scope,
        scopeId,
        hours: body.data.hours,
        confirmSlug: body.data.confirm_slug,
        basis: body.data.basis,
      }),
    );
  });

  app.delete(`${base}/policy`, small, async (c) => {
    const q = z.object({ scope: Scope, scope_id: Id.optional() }).safeParse(c.req.query());
    if (!q.success) return invalid(c);
    const p = c.get("principal");
    const scopeId = q.data.scope === "workspace" ? p.workspaceId : q.data.scope_id;
    if (!scopeId) return invalid(c);
    const result = await retention.clearPolicy(p, clientOf(c), q.data.scope, scopeId);
    if (!result.ok) return send(c, result);
    return result.value ? c.body(null, 204) : send(c, { ok: false, reason: "NOT_FOUND" });
  });

  app.get(`${base}/holds`, async (c) =>
    send(
      c,
      await retention
        .holds(c.get("principal"))
        .then((o) => (o.ok ? { ok: true as const, value: { holds: o.value } } : o)),
    ),
  );

  app.put(`${base}/holds`, small, async (c) => {
    const body = HoldBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const result = await retention.setHold(c.get("principal"), clientOf(c), {
      objectType: body.data.object_type,
      objectId: body.data.object_id,
      held: body.data.held,
      ...(body.data.reason === undefined ? {} : { reason: body.data.reason }),
    });
    return send(c, result.ok ? { ok: true as const, value: { changed: result.value } } : result);
  });

  app.get(`${base}/bin`, async (c) => {
    const result = await retention.bin(c.get("principal"), {
      includeClosed: c.req.query("include_closed") === "true",
    });
    return send(c, result.ok ? { ok: true as const, value: { items: result.value } } : result);
  });

  app.post(`${base}/bin/:id/restore`, async (c) => {
    const id = idOf(c);
    if (!id) return invalid(c);
    return send(c, await retention.restore(c.get("principal"), clientOf(c), id));
  });

  app.post(`${base}/bin/:id/purge`, async (c) => {
    const id = idOf(c);
    if (!id) return invalid(c);
    return send(c, await retention.purgeNow(c.get("principal"), clientOf(c), id));
  });

  app.get(`${base}/jobs`, async (c) => {
    const result = await retention.jobs(c.get("principal"));
    return send(c, result.ok ? { ok: true as const, value: { jobs: result.value } } : result);
  });

  app.get(`${base}/exemptions`, (c) => c.json({ exemptions: retention.exemptions() }));

  return app;
}
