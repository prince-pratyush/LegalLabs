import { AcceptInvite, GroupInput, InviteUsers, RoleInput, UserPatch } from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import { createLimiter } from "../auth/limiter.js";
import { type Users, UsersRefused } from "./users.js";

type Env = { Variables: { principal: Principal } };

const INVALID = { code: "INVALID_REQUEST", message: "Check the details and try again." };

const small = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json(INVALID, 400) });

const read = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | null> => {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
};

const slowDown = (c: Context, wait: number) => {
  c.header("Retry-After", String(wait));
  return c.json({ code: "TOO_MANY", message: "Wait a moment, then try again." }, 429);
};

/** `/api/v1/admin/users`, `/roles` and `/groups`, behind the normal sign-in. */
export function userAdminRoutes(
  users: Users,
  clientOf: (c: Context) => Client,
  now: () => number = Date.now,
) {
  const app = new Hono<Env>();
  // Each of these can send mail, so one account can't send without end.
  const invites = createLimiter({ limit: 20, windowMs: 10 * 60_000, now });

  app.onError((err, c) => {
    if (err instanceof UsersRefused) {
      return c.json({ code: err.code, message: err.message }, err.status);
    }
    throw err;
  });

  const id = (c: Context) => {
    const parsed = z.uuid().safeParse(c.req.param("id"));
    if (!parsed.success) throw new UsersRefused(404, "NOT_FOUND", "That wasn't found.");
    return parsed.data;
  };

  app.get("/admin/users", async (c) => c.json(await users.list(c.get("principal"))));
  app.post("/admin/users/invite", small, async (c) => {
    const input = await read(c, InviteUsers);
    if (!input) return c.json(INVALID, 400);
    const wait = invites.take(c.get("principal").userId);
    if (wait > 0) return slowDown(c, wait);
    return c.json(await users.invite(c.get("principal"), input, clientOf(c)));
  });
  app.post("/admin/users/:id/invite", async (c) => {
    const wait = invites.take(c.get("principal").userId);
    if (wait > 0) return slowDown(c, wait);
    return c.json(await users.resend(c.get("principal"), id(c), clientOf(c)));
  });
  app.patch("/admin/users/:id", small, async (c) => {
    const input = await read(c, UserPatch);
    if (!input) return c.json(INVALID, 400);
    return c.json(await users.update(c.get("principal"), id(c), input, clientOf(c)));
  });

  app.get("/admin/roles", async (c) => c.json({ items: await users.roles(c.get("principal")) }));
  app.post("/admin/roles", small, async (c) => {
    const input = await read(c, RoleInput);
    if (!input) return c.json(INVALID, 400);
    return c.json(await users.createRole(c.get("principal"), input, clientOf(c)), 201);
  });
  app.get("/admin/groups", async (c) => c.json({ items: await users.groups(c.get("principal")) }));
  app.post("/admin/groups", small, async (c) => {
    const input = await read(c, GroupInput);
    if (!input) return c.json(INVALID, 400);
    return c.json(await users.createGroup(c.get("principal"), input.name, clientOf(c)), 201);
  });
  return app;
}

/** `/auth/invite`: reachable without a session, by whoever holds a link. */
export function inviteRoutes(
  users: Users,
  clientOf: (c: Context) => Client,
  clientIp: (c: Context) => string | null,
  now: () => number = Date.now,
) {
  const app = new Hono();
  const perIp = createLimiter({ limit: 10, windowMs: 60_000, now });

  app.post("/accept", small, async (c) => {
    const wait = perIp.take(clientIp(c) ?? "unknown");
    if (wait > 0) return slowDown(c, wait);
    const input = await read(c, AcceptInvite);
    if (!input) return c.json(INVALID, 400);
    const done = await users.accept(input.token, input.password, clientOf(c));
    if (!done) {
      return c.json(
        {
          code: "INVITE_INVALID",
          message: "This link has been used or has expired. Ask for a new invitation.",
        },
        400,
      );
    }
    return c.json(done);
  });
  return app;
}
