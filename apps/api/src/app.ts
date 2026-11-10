import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { type Auth, type Client, type Principal, SESSION_SECONDS } from "./auth/auth.js";
import { createLimiter } from "./auth/limiter.js";
import { MAX_PASSWORD_LENGTH } from "./auth/password.js";
import type { Documents } from "./documents/documents.js";
import { documentRoutes } from "./documents/routes.js";
import { threadRoutes } from "./threads/routes.js";
import type { Threads } from "./threads/threads.js";

const COOKIE = "sid";
const COOKIE_PREFIX: "host" = "host";

// Capped so nobody can make the server hash a huge password.
const lookupText = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((text) => !text.includes("\0"), "Postgres text cannot hold a NUL byte");

const loginBody = z.object({
  workspace: lookupText(1, 63),
  email: lookupText(3, 320),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export interface AppOptions {
  auth: Auth;
  documents: Documents;
  threads: Threads;
  /** The socket address only: forwarded headers can be forged by the caller. */
  clientIp: (c: Context) => string | null;
  now?: () => number;
}

export function createApp({ auth, documents, threads, clientIp, now = Date.now }: AppOptions) {
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

    const previous = getCookie(c, COOKIE, COOKIE_PREFIX);
    if (previous) await auth.logout(previous, clientOf(c));

    setCookie(c, COOKIE, result.token, {
      prefix: COOKIE_PREFIX,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_SECONDS,
    });
    return c.json({ user_id: result.principal.userId, workspace_id: result.principal.workspaceId });
  });

  app.post("/auth/logout", async (c) => {
    const token = getCookie(c, COOKIE, COOKIE_PREFIX);
    if (token) await auth.logout(token, clientOf(c));
    deleteCookie(c, COOKIE, { prefix: COOKIE_PREFIX, secure: true, path: "/" });
    return c.body(null, 204);
  });

  app.get("/auth/session", async (c) => {
    const token = getCookie(c, COOKIE, COOKIE_PREFIX);
    const principal = token ? await auth.resolve(token) : null;
    if (!principal) return c.json({ error: "unauthenticated" }, 401);
    return c.json({ user_id: principal.userId, workspace_id: principal.workspaceId });
  });

  app.use("/api/v1/*", async (c, next) => {
    const token = getCookie(c, COOKIE, COOKIE_PREFIX);
    const principal = token ? await auth.resolve(token) : null;
    if (!principal) return c.json({ code: "UNAUTHENTICATED", message: "Sign in first." }, 401);
    c.set("principal", principal);
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.route("/api/v1/documents", documentRoutes(documents, clientOf));
  app.route("/api/v1/threads", threadRoutes(threads, clientOf, now));

  return app;
}
