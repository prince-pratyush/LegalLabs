import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { type Auth, type Client, type Principal, SESSION_SECONDS } from "./auth/auth.js";
import { createLimiter } from "./auth/limiter.js";

const COOKIE = "sid";
const PREFIX = "host";

// Capped so nobody can make the server hash a huge password.
const loginBody = z.object({
  workspace: z.string().min(1).max(63),
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(256),
});

export interface AppOptions {
  auth: Auth;
  /** The socket address only: forwarded headers can be forged by the caller. */
  clientIp: (c: Context) => string | null;
  now?: () => number;
}

export function createApp({ auth, clientIp, now = Date.now }: AppOptions) {
  const perIp = createLimiter({ limit: 10, windowMs: 60_000, now });
  const perAccount = createLimiter({ limit: 5, windowMs: 60_000, now });
  const app = new Hono<{ Variables: { principal: Principal } }>();

  const clientOf = (c: Context): Client => ({
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
  });

  app.use("/auth/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.post("/auth/login", bodyLimit({ maxSize: 4096 }), async (c) => {
    const parsed = loginBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const attempt = parsed.data;

    // The address goes first, so one caller can't fill memory with account keys.
    const wait =
      perIp.take(clientIp(c) ?? "unknown") ||
      perAccount.take(`${attempt.workspace}|${attempt.email}`.toLowerCase());
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "too_many_attempts" }, 429);
    }

    const result = await auth.login(attempt, clientOf(c));
    if (!result) return c.json({ error: "invalid_credentials" }, 401);

    setCookie(c, COOKIE, result.token, {
      prefix: PREFIX,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_SECONDS,
    });
    return c.json({ user_id: result.principal.userId, workspace_id: result.principal.workspaceId });
  });

  app.post("/auth/logout", async (c) => {
    const token = getCookie(c, COOKIE, PREFIX);
    if (token) await auth.logout(token, clientOf(c));
    deleteCookie(c, COOKIE, { prefix: PREFIX, secure: true, path: "/" });
    return c.body(null, 204);
  });

  app.get("/auth/session", async (c) => {
    const token = getCookie(c, COOKIE, PREFIX);
    const principal = token ? await auth.resolve(token) : null;
    if (!principal) return c.json({ error: "unauthenticated" }, 401);
    return c.json({ user_id: principal.userId, workspace_id: principal.workspaceId });
  });

  return app;
}
