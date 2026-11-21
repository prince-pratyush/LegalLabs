import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { createCodeStore } from "./addins/codes.js";
import type { Language } from "./addins/language.js";
import { addinAuthRoutes, addinRoutes } from "./addins/routes.js";
import { type Auth, type Client, type Principal, SESSION_SECONDS } from "./auth/auth.js";
import { createLimiter } from "./auth/limiter.js";
import { MAX_PASSWORD_LENGTH } from "./auth/password.js";
import type { Documents } from "./documents/documents.js";
import { documentRoutes } from "./documents/routes.js";
import type { Viewer } from "./documents/viewer.js";
import { viewerRoutes } from "./documents/viewer-routes.js";
import type { Drafts } from "./drafts/drafts.js";
import { draftHttp } from "./drafts/http.js";
import type { Knowledge } from "./knowledge/knowledge.js";
import { knowledgeRoutes } from "./knowledge/routes.js";
import type { Library } from "./library/library.js";
import { libraryRoutes } from "./library/routes.js";
import type { Matters } from "./matters/matters.js";
import { matterRoutes } from "./matters/routes.js";
import type { MemoryModule } from "./memory/module.js";
import { memoryRoutes, styleRoutes } from "./memory/routes.js";
import type { Notifications } from "./notifications/notifications.js";
import { notificationRoutes } from "./notifications/routes.js";
import { playbookHttp } from "./playbooks/http.js";
import type { Playbooks } from "./playbooks/playbooks.js";
import { reviewHttp } from "./reviews/http.js";
import type { Reviews } from "./reviews/reviews.js";
import { spaceHttp } from "./spaces/http.js";
import type { SpaceModule } from "./spaces/module.js";
import { tableHttp } from "./tables/http.js";
import type { ReviewTables } from "./tables/module.js";
import { ASK_WINDOW_MS, type ThreadHttpOptions, threadHttp } from "./threads/http.js";
import { adminVaultRoutes, vaultRoutes } from "./vaults/routes.js";
import type { Vaults } from "./vaults/vaults.js";

const COOKIE = "sid";
const COOKIE_PREFIX: "host" = "host";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// Nothing inline and nothing from elsewhere, so injected text can't run as script.
const CONTENT_POLICY =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'";
// The Word pane loads Office's script from Microsoft and runs framed inside Word on the web.
const ADDIN_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://appsforoffice.microsoft.com",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'self' https://*.office.com https://*.officeapps.live.com https://*.office365.com https://*.sharepoint.com https://*.microsoft365.com https://*.cloud.microsoft",
].join("; ");
const BEARER = /^Bearer ([\w-]{20,100})$/;

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
  threads: Omit<ThreadHttpOptions, "clientOf" | "now">;
  /** Pages and files for the document viewer. */
  viewer?: Viewer;
  drafts: Drafts;
  /** Optional, so harnesses that don't touch vaults needn't build one. */
  vaults?: Vaults;
  /** Optional in the same way as vaults. */
  tables?: ReviewTables;
  /** Optional, like vaults. */
  library?: Library;
  /** Matters, walls and their admin screens; optional like vaults. */
  matters?: Matters;
  /** Spaces, their tasks and templates; left out, those endpoints are not mounted. */
  spaces?: SpaceModule;
  /** The notifications hub; optional, like vaults. */
  notifications?: Notifications;
  /** Memories and writing styles; optional, like vaults. */
  memory?: MemoryModule;
  /** Public-law sources; left out, the knowledge endpoints are not mounted. */
  knowledge?: Knowledge;
  /** Optional, so harnesses that don't touch playbooks needn't build one. */
  playbooks?: Playbooks;
  /** Playbook reviews; mounted only with playbooks. */
  reviews?: Reviews;
  /** The socket address only: forwarded headers can be forged by the caller. */
  clientIp: (c: Context) => string | null;
  now?: () => number;
  /** The built web app, served on the same origin so the session cookie needs no CORS. */
  webRoot?: string;
  /** The Word add-in: its tools, its audit hook and, when built, its pane under /addin/. */
  addin?: {
    language: Language;
    recordSignIn: (principal: Principal, client: Client) => Promise<void>;
    root?: string;
  };
}

export function createApp({
  auth,
  documents,
  threads,
  viewer,
  drafts,
  vaults,
  tables,
  library,
  matters,
  spaces,
  notifications,
  memory,
  knowledge,
  playbooks,
  reviews,
  clientIp,
  now = Date.now,
  webRoot,
  addin,
}: AppOptions) {
  const perIp = createLimiter({ limit: 10, windowMs: 60_000, now });
  const perAccount = createLimiter({ limit: 5, windowMs: 60_000, now });
  const app = new Hono<{ Variables: { principal: Principal } }>();

  const clientOf = (c: Context): Client => ({
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
  });

  // The pane can't share the web cookie inside Word on the web, so it sends the token instead.
  const tokenOf = (c: Context) =>
    BEARER.exec(c.req.header("authorization") ?? "")?.[1] ??
    getCookie(c, COOKIE, COOKIE_PREFIX) ??
    null;

  app.use(async (c, next) => {
    await next();
    // Only the pane is framed by Word; the sign-in dialog is a window of its own, never framed.
    const pane =
      (c.req.path === "/addin" || c.req.path.startsWith("/addin/")) &&
      c.req.path !== "/addin/auth.html";
    c.header("Content-Security-Policy", pane ? ADDIN_POLICY : CONTENT_POLICY);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
  });

  // The browser sends the cookie with a cross-site form post, so a write must come from this
  // host. A missing Origin is a non-browser client, which has no cookie of ours to borrow.
  app.use(async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !SAFE_METHODS.has(c.req.method)) {
      const host = new URL(c.req.url).host;
      if (!URL.canParse(origin) || new URL(origin).host !== host) {
        return c.json(
          { code: "FORBIDDEN_ORIGIN", message: "This request came from another site." },
          403,
        );
      }
    }
    await next();
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
    const token = tokenOf(c);
    if (token) await auth.logout(token, clientOf(c));
    deleteCookie(c, COOKIE, { prefix: COOKIE_PREFIX, secure: true, path: "/" });
    return c.body(null, 204);
  });

  app.get("/auth/session", async (c) => {
    const token = tokenOf(c);
    const principal = token ? await auth.resolve(token) : null;
    if (!principal) return c.json({ error: "unauthenticated" }, 401);
    return c.json({ user_id: principal.userId, workspace_id: principal.workspaceId });
  });

  if (addin) {
    app.route(
      "/auth/addin",
      addinAuthRoutes({
        auth,
        codes: createCodeStore(now),
        tokenOf,
        clientOf,
        recordSignIn: addin.recordSignIn,
        now,
      }),
    );
  }

  app.use("/api/v1/*", async (c, next) => {
    const token = tokenOf(c);
    const principal = token ? await auth.resolve(token) : null;
    if (!principal) return c.json({ code: "UNAUTHENTICATED", message: "Sign in first." }, 401);
    c.set("principal", principal);
    await next();
    c.header("Cache-Control", "no-store");
  });

  if (viewer) app.route("/api/v1/documents", viewerRoutes(viewer, clientOf));
  app.route("/api/v1/documents", documentRoutes(documents, clientOf));
  // One budget of model calls per person, whether they ask a thread or draft playbook rules.
  const asks = createLimiter({
    limit: threads.asksPerWindow ?? 20,
    windowMs: ASK_WINDOW_MS,
    now,
  });
  // Before threads, so a table run's cancel is handled here and a thread run's falls through.
  if (tables) app.route("/api/v1", tableHttp({ ...tables, clientOf, asks }));
  app.route("/api/v1", threadHttp({ ...threads, asks, clientOf, now }));
  app.route("/api/v1", draftHttp(drafts, clientOf));
  if (vaults) {
    app.route("/api/v1/vaults", vaultRoutes(vaults, clientOf));
    app.route("/api/v1/admin/vaults", adminVaultRoutes(vaults, clientOf));
  }
  if (playbooks) app.route("/api/v1", playbookHttp(playbooks, clientOf, asks));
  if (reviews) app.route("/api/v1", reviewHttp(reviews, clientOf, asks));
  if (library) app.route("/api/v1/library", libraryRoutes(library, clientOf));
  if (matters) app.route("/api/v1", matterRoutes(matters, clientOf));
  if (spaces) app.route("/api/v1", spaceHttp(spaces, clientOf));
  if (notifications) app.route("/api/v1", notificationRoutes(notifications, clientOf, { now }));
  if (memory) {
    app.route("/api/v1", memoryRoutes(memory.memories, clientOf));
    app.route("/api/v1", styleRoutes(memory.styles, clientOf));
  }
  if (addin) app.route("/api/v1/addin", addinRoutes(addin.language, now));
  if (addin?.root) {
    app.get("/addin/*", serveStatic({ root: addin.root, rewriteRequestPath: (p) => p.slice(6) }));
  }
  if (knowledge) app.route("/api/v1/knowledge", knowledgeRoutes(knowledge));
  if (webRoot) {
    // A deep link to a document loads the app, which then opens the viewer.
    app.get("/documents/*", serveStatic({ root: webRoot, path: "index.html" }));
    app.get("/d/*", serveStatic({ root: webRoot, path: "index.html" }));
    // Build files carry a hash of their content in the name, so a copy never goes stale.
    app.use("/assets/*", async (c, next) => {
      await next();
      if (c.res.status === 200) c.header("Cache-Control", "public, max-age=31536000, immutable");
    });
    app.get("*", serveStatic({ root: webRoot }));
  }

  return app;
}
