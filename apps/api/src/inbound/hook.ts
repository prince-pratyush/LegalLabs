import { type Context, Hono } from "hono";
import { createLimiter } from "../auth/limiter.js";
import type { EmailChannels } from "../intake/channels.js";
import { EMAIL_LIMITS } from "./email.js";
import { verifyTimestamped } from "./signature.js";

// The one way in that needs no session: the receiving mail server posts a raw message, signed.
// Every cheap check comes before the body is read, and the signature before anything is kept.
// Nothing here parses the message, answers the sender or writes any of it to a log.

export interface EmailHookOptions {
  /** The caller's address, behind any trusted proxy. */
  clientIp: (c: Context) => string | null;
  now?: () => number;
}

const KEY = /^[A-Za-z0-9_-]{32}$/;
const WINDOW_SECONDS = 300;
// Each body is held whole while it is checked and queued.
const MAX_CONCURRENT = 4;
const READ_DEADLINE_MS = 60_000;

/** The body, or null once it passes the cap or takes too long: never more is held than that. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Buffer | null> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let late = false;
  const deadline = setTimeout(() => {
    late = true;
    reader.cancel().catch(() => {});
  }, READ_DEADLINE_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return late ? null : Buffer.concat(chunks);
      size += value.length;
      if (size > max) {
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(deadline);
  }
}

export function emailHook(channels: EmailChannels, options: EmailHookOptions) {
  const { now = Date.now } = options;
  const perAddress = createLimiter({ limit: 120, windowMs: 60_000, now });
  const perChannel = createLimiter({ limit: 120, windowMs: 60_000, now });
  const app = new Hono();
  let reading = 0;

  // One answer for an unknown channel, a missing or wrong signature and a stale one.
  const unauthorised = (c: Context) =>
    c.json({ code: "UNAUTHORIZED", message: "That request wasn't accepted." }, 401);
  const tooLarge = (c: Context) =>
    c.json({ code: "TOO_LARGE", message: "That message is too large." }, 413);
  const later = (c: Context, status: 429 | 503, seconds: number) => {
    c.header("Retry-After", String(seconds));
    return c.json({ code: "TRY_LATER", message: "Send it again later." }, status);
  };

  app.post("/email/:key", async (c) => {
    c.header("Cache-Control", "no-store");
    const flooding = perAddress.take(options.clientIp(c) ?? "unknown");
    if (flooding) return later(c, 429, flooding);

    const key = c.req.param("key");
    const timestamp = c.req.header("x-legallabs-timestamp");
    const signature = c.req.header("x-legallabs-signature");
    const age = Math.abs(Math.floor(now() / 1000) - Number(timestamp));
    if (
      !KEY.test(key) ||
      !/^\d{1,12}$/.test(timestamp ?? "") ||
      !/^v0=[0-9a-f]{64}$/.test(signature ?? "") ||
      age > WINDOW_SECONDS
    ) {
      return unauthorised(c);
    }
    const channel = await channels.open(key);
    if (!channel) return unauthorised(c);

    if (Number(c.req.header("content-length") ?? 0) > EMAIL_LIMITS.bytes) return tooLarge(c);
    if (reading >= MAX_CONCURRENT) return later(c, 503, 5);
    reading++;
    try {
      const raw = await readCapped(c.req.raw.body, EMAIL_LIMITS.bytes);
      if (!raw) return tooLarge(c);
      const signed = channel.secrets.some((secret) =>
        verifyTimestamped(
          secret,
          raw,
          { timestamp, signature },
          { now: now(), windowSeconds: WINDOW_SECONDS },
        ),
      );
      if (!signed) return unauthorised(c);
      const spent = perChannel.take(channel.id);
      if (spent) return later(c, 429, spent);

      const outcome = await channels.receive(channel.id, raw);
      if (outcome === "unknown") return unauthorised(c);
      if (outcome === "full") return later(c, 429, 600);
      // A repeat is answered as the first was, so the mail server stops sending it.
      return c.json({ status: "accepted" }, 202);
    } finally {
      reading--;
    }
  });

  // A database error quotes the row it refused, which here is the message.
  app.onError((err, c) => {
    const { code } = err as { code?: string };
    console.error(`email hook failed: ${code ?? err.name}`);
    return c.json({ code: "FAILED", message: "Send it again later." }, 500);
  });

  return app;
}
