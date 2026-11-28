import { SsoInput } from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Client, Principal } from "../auth.js";
import { createLimiter } from "../limiter.js";
import { type SsoAdmin, SsoRefused } from "./admin.js";

type Env = { Variables: { principal: Principal } };

const INVALID = { code: "INVALID_REQUEST", message: "Check the details and try again." };

/** `/api/v1/admin/identity/sso`, behind the normal sign-in. */
export function ssoAdminRoutes(
  sso: SsoAdmin,
  clientOf: (c: Context) => Client,
  now: () => number = Date.now,
) {
  const app = new Hono<Env>();
  // Each save makes this server call the address given, so it can't be done without end.
  const saves = createLimiter({ limit: 10, windowMs: 60_000, now });

  app.onError((err, c) => {
    if (err instanceof SsoRefused) {
      return c.json({ code: err.code, message: err.message }, err.status);
    }
    throw err;
  });

  app.get("/admin/identity/sso", async (c) => c.json(await sso.get(c.get("principal"))));
  app.put(
    "/admin/identity/sso",
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json(INVALID, 400) }),
    async (c) => {
      const parsed = SsoInput.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json(INVALID, 400);
      const wait = saves.take(c.get("principal").userId);
      if (wait > 0) {
        c.header("Retry-After", String(wait));
        return c.json({ code: "TOO_MANY", message: "Wait a moment, then try again." }, 429);
      }
      return c.json(await sso.put(c.get("principal"), parsed.data, clientOf(c)));
    },
  );
  return app;
}
