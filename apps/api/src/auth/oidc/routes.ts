import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Client } from "../auth.js";
import { createLimiter } from "../limiter.js";
import { setPendingCookie } from "../mfa/pending-cookie.js";
import type { Oidc } from "./service.js";

// Short and path-scoped: it only has to survive the round trip to the IdP.
const BINDING_COOKIE = "oidc";
const BINDING_SECONDS = 10 * 60;

export interface OidcRouteOptions {
  oidc: Oidc;
  clientOf: (c: Context) => Client;
  /** Sets the session cookie and ends any session the browser already had. */
  signedIn: (c: Context, token: string) => Promise<void>;
  now?: () => number;
}

export function oidcRoutes({ oidc, clientOf, signedIn, now = Date.now }: OidcRouteOptions) {
  const perIp = createLimiter({ limit: 30, windowMs: 60_000, now });
  const app = new Hono();
  // A person's browser is taken back to the sign-in screen; anything else gets the code.
  const turnedAway = (
    c: Context,
    error: string,
    status: 401 | 404 | 429 | 502,
    why: "failed" | "unavailable" | "busy",
  ) =>
    c.req.header("accept")?.includes("text/html")
      ? c.redirect(`/#/auth/sso?error=${why}`, 302)
      : c.json({ error }, status);

  app.get("/start", async (c) => {
    const wait = perIp.take(clientOf(c).ip ?? "unknown");
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return turnedAway(c, "too_many_attempts", 429, "busy");
    }
    const workspace = c.req.query("workspace");
    if (!workspace || workspace.length > 63 || workspace.includes("\0")) {
      return c.json({ error: "invalid_request" }, 400);
    }
    let started: Awaited<ReturnType<Oidc["begin"]>>;
    try {
      started = await oidc.begin(workspace, { returnTo: c.req.query("return_to") ?? null });
    } catch {
      return turnedAway(c, "sso_unavailable", 502, "unavailable");
    }
    if (!started) return turnedAway(c, "sso_not_enabled", 404, "unavailable");
    setCookie(c, BINDING_COOKIE, started.binding, {
      prefix: "host",
      httpOnly: true,
      secure: true,
      // Lax: the IdP's redirect back is a top-level GET, which Strict would not carry.
      sameSite: "Lax",
      path: "/",
      maxAge: BINDING_SECONDS,
    });
    return c.redirect(started.url, 302);
  });

  app.get("/callback", async (c) => {
    const binding = getCookie(c, BINDING_COOKIE, "host");
    deleteCookie(c, BINDING_COOKIE, { prefix: "host", secure: true, path: "/" });
    const q = c.req.query();
    const result = await oidc.complete(
      {
        ...(q.code ? { code: q.code } : {}),
        ...(q.state ? { state: q.state } : {}),
        ...(q.error ? { error: q.error } : {}),
        ...(q.iss !== undefined ? { iss: q.iss } : {}),
      },
      binding,
      clientOf(c),
    );
    // The reason stays in the audit log: the caller learns only that sign-in failed.
    if (!result.ok) return turnedAway(c, "sso_failed", 401, "failed");
    if ("pending" in result) {
      const { kind, mfaToken, methods } = result.pending;
      // Never in the address: only the browser that started sign-in gets to finish it.
      setPendingCookie(c, mfaToken);
      return c.redirect(`/#/auth/mfa?kind=${kind}&methods=${methods.join(",")}`, 302);
    }
    await signedIn(c, result.token);
    return c.redirect(result.returnTo, 302);
  });

  return app;
}
