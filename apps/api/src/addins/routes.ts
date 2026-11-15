import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Auth, Client, Principal } from "../auth/auth.js";
import { createLimiter } from "../auth/limiter.js";
import type { CodeStore } from "./codes.js";
import { LANGUAGES, type Language, MAX_BATCH_CHARS, MAX_BATCH_PARAGRAPHS } from "./language.js";

type Env = { Variables: { principal: Principal } };

export interface AddinAuthOptions {
  auth: Auth;
  codes: CodeStore;
  /** The caller's session token from the cookie, or null. */
  tokenOf: (c: Context) => string | null;
  clientOf: (c: Context) => Client;
  /** Audits the pane's sign-in under the user, in the same log as web sign-ins. */
  recordSignIn: (principal: Principal, client: Client) => Promise<void>;
  now: () => number;
}

const noNul = (text: string) => !text.includes("\0");
const exchangeBody = z.object({ code: z.string().min(20).max(100).refine(noNul) });

/** The dialog signs in on the web origin, then hands the pane a code, never the cookie. */
export function addinAuthRoutes({
  auth,
  codes,
  tokenOf,
  clientOf,
  recordSignIn,
  now,
}: AddinAuthOptions) {
  const perIp = createLimiter({ limit: 20, windowMs: 60_000, now });
  // Codes share one store, so one user minting many can't push out everyone else's.
  const perUser = createLimiter({ limit: 5, windowMs: 60_000, now });
  const app = new Hono();

  app.post("/code", async (c) => {
    const token = tokenOf(c);
    const principal = token ? await auth.resolve(token) : null;
    if (!token || !principal) return c.json({ error: "unauthenticated" }, 401);
    const wait = perUser.take(principal.userId);
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "too_many_attempts" }, 429);
    }
    return c.json({ code: codes.issue(token) });
  });

  app.post("/exchange", bodyLimit({ maxSize: 1024 }), async (c) => {
    const wait = perIp.take(clientOf(c).ip ?? "unknown");
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "too_many_attempts" }, 429);
    }
    const parsed = exchangeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const token = codes.redeem(parsed.data.code);
    // Checked again: the session may have been revoked since the code was issued.
    const principal = token ? await auth.resolve(token) : null;
    if (!token || !principal) return c.json({ error: "invalid_code" }, 401);
    await recordSignIn(principal, clientOf(c));
    return c.json({ token, user_id: principal.userId, workspace_id: principal.workspaceId });
  });

  return app;
}

const paragraphs = z
  .array(z.string().max(MAX_BATCH_CHARS).refine(noNul))
  .min(1)
  .max(MAX_BATCH_PARAGRAPHS)
  .refine((list) => list.reduce((n, p) => n + p.length, 0) <= MAX_BATCH_CHARS, {
    message: `Send at most ${MAX_BATCH_CHARS} characters at a time.`,
  });
// A fixed list: the name goes into the prompt, so it can't carry instructions.
const targetLanguage = z.enum(LANGUAGES);

const proofreadBody = z.object({ paragraphs });
const translateBody = z.object({ paragraphs, language: targetLanguage });

export function addinRoutes(language: Language, now: () => number) {
  // Each batch is a model call, and a long document is many batches.
  const perUser = createLimiter({ limit: 60, windowMs: 10 * 60_000, now });
  const app = new Hono<Env>();
  const limitBody = bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ code: "INVALID_REQUEST", message: "Send less text at a time." }, 400),
  });

  const invalid = (c: Context) =>
    c.json({ code: "INVALID_REQUEST", message: "Check the text and language sent." }, 400);
  const limited = (c: Context<Env>) => {
    const wait = perUser.take(c.get("principal").userId);
    if (wait === 0) return null;
    c.header("Retry-After", String(wait));
    return c.json(
      { code: "TOO_MANY_REQUESTS", message: "That's a lot of text just now. Try again shortly." },
      429,
    );
  };
  const unavailable = (c: Context) =>
    c.json({ code: "MODEL_UNAVAILABLE", message: "No model is available right now." }, 503);

  app.post("/proofread", limitBody, async (c) => {
    const parsed = proofreadBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    const stop = limited(c);
    if (stop) return stop;
    const result = await language.proofread(c.get("principal").workspaceId, parsed.data.paragraphs);
    if (!result.ok) return unavailable(c);
    return c.json({ suggestions: result.value, model: result.model });
  });

  app.post("/translate", limitBody, async (c) => {
    const parsed = translateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    const stop = limited(c);
    if (stop) return stop;
    const { paragraphs: list, language: target } = parsed.data;
    const result = await language.translate(c.get("principal").workspaceId, list, target);
    if (!result.ok) return unavailable(c);
    return c.json({ paragraphs: result.value, model: result.model });
  });

  return app;
}
