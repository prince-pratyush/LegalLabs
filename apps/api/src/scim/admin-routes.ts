import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import { AdminRefused, type ScimAdmin } from "./admin.js";

const uuid = z.string().uuid();

/** Admin screens' API for SCIM, behind the normal session sign-in. */
export function scimAdminRoutes(admin: ScimAdmin, clientOf: (c: Context) => Client) {
  const app = new Hono<{ Variables: { principal: Principal } }>();

  app.onError((err, c) => {
    if (err instanceof AdminRefused) {
      return c.json(
        { code: err.status === 403 ? "FORBIDDEN" : "INVALID", message: err.message },
        err.status,
      );
    }
    throw err;
  });

  const body = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AdminRefused(400, "The request body is not valid.");
    return parsed.data;
  };
  const id = (c: Context) => {
    const parsed = uuid.safeParse(c.req.param("id"));
    if (!parsed.success) throw new AdminRefused(404, "Not found.");
    return parsed.data;
  };

  app.get("/admin/scim", async (c) => c.json(await admin.status(c.get("principal"))));
  app.put("/admin/scim", async (c) => {
    const input = await body(
      c,
      z.object({
        enabled: z.boolean(),
        ip_allowlist: z.array(z.string().max(64)).max(50).optional(),
      }),
    );
    await admin.configure(c.get("principal"), clientOf(c), {
      enabled: input.enabled,
      ...(input.ip_allowlist ? { ipAllowlist: input.ip_allowlist } : {}),
    });
    return c.body(null, 204);
  });
  app.post("/admin/scim/tokens", async (c) => {
    const input = await body(
      c,
      z.object({
        name: z.string().min(1).max(200),
        days: z.number().int().min(1).max(365).optional(),
      }),
    );
    const made = await admin.createToken(c.get("principal"), clientOf(c), {
      name: input.name,
      ...(input.days ? { days: input.days } : {}),
    });
    return c.json(made, 201);
  });
  app.delete("/admin/scim/tokens/:id", async (c) => {
    await admin.revokeToken(c.get("principal"), clientOf(c), id(c));
    return c.body(null, 204);
  });
  app.post("/admin/scim/resume", async (c) =>
    c.json({ resumed: await admin.resume(c.get("principal"), clientOf(c)) }),
  );
  app.get("/admin/scim/group-roles", async (c) => c.json(await admin.mappings(c.get("principal"))));
  app.post("/admin/scim/group-roles", async (c) => {
    const input = await body(
      c,
      z.object({
        group_id: uuid,
        role_id: uuid,
        priority: z.number().int().min(0).max(10000).optional(),
      }),
    );
    const mappingId = await admin.requestMapping(c.get("principal"), clientOf(c), {
      groupId: input.group_id,
      roleId: input.role_id,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    });
    return c.json({ id: mappingId }, 201);
  });
  app.post("/admin/scim/group-roles/:id/confirm", async (c) => {
    await admin.confirmMapping(c.get("principal"), clientOf(c), id(c));
    return c.body(null, 204);
  });
  app.delete("/admin/scim/group-roles/:id", async (c) => {
    await admin.removeMapping(c.get("principal"), clientOf(c), id(c));
    return c.body(null, 204);
  });
  return app;
}
