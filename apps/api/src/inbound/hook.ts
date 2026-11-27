import { type Context, Hono } from "hono";
import { createLimiter } from "../auth/limiter.js";
import type { EmailChannels } from "../intake/channels.js";
import { checkSender, EMAIL_LIMITS, senderHash } from "./email.js";
import { verifyTimestamped } from "./signature.js";

// The one way in that needs no session: the receiving mail server posts a raw message, signed.
// Every cheap check comes before the body is read, and the signature before anything is kept.
// Only the headers are read here, to turn away at once what would never be taken. Nothing
// answers the sender or writes any of the message to a log.

export interface EmailHookOptions {
  /** The caller's address, behind any trusted proxy. */
  clientIp: (c: Context) => string | null;
  now?: () => number;
  /** How long a body may send nothing before it is dropped. */
  idleMs?: number;
}

const KEY = /^[A-Za-z0-9_-]{32}$/;
const WINDOW_SECONDS = 300;
// Each body is held whole while it is checked and queued. No one address or channel may
// have all of the places.
const MAX_CONCURRENT = 4;
const MAX_PER_SOURCE = 2;
const IDLE_MS = 10_000;
const READ_DEADLINE_MS = 60_000;

/** The body, unless it passes the cap, goes quiet or takes too long in all. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  idleMs: number,
): Promise<Buffer | "large" | "late"> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let late = false;
  const drop = () => {
    late = true;
    reader.cancel().catch(() => {});
  };
  const deadline = setTimeout(drop, READ_DEADLINE_MS);
  let idle = setTimeout(drop, idleMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (late) return "late";
      if (done) return Buffer.concat(chunks);
      clearTimeout(idle);
      idle = setTimeout(drop, idleMs);
      size += value.length;
      if (size > max) {
        reader.cancel().catch(() => {});
        return "large";
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(deadline);
    clearTimeout(idle);
  }
}

/** Counts what is in progress for each key. */
function places(max: number) {
  const held = new Map<string, number>();
  return {
    full: (key: string) => (held.get(key) ?? 0) >= max,
    take(key: string) {
      held.set(key, (held.get(key) ?? 0) + 1);
    },
    free(key: string) {
      const left = (held.get(key) ?? 1) - 1;
      if (left > 0) held.set(key, left);
      else held.delete(key);
    },
  };
}

export function emailHook(channels: EmailChannels, options: EmailHookOptions) {
  const { now = Date.now, idleMs = IDLE_MS } = options;
  // Failures and signed messages are counted apart: junk from an address everyone shares,
  // a proxy say, must not shut out a channel that signs.
  const failures = createLimiter({ limit: 120, windowMs: 60_000, now });
  const perChannel = createLimiter({ limit: 120, windowMs: 60_000, now });
  /** Keys that have signed correctly, which a run of junk does not keep from being looked up. */
  const known = new Set<string>();
  const byAddress = places(MAX_PER_SOURCE);
  const byChannel = places(MAX_PER_SOURCE);
  const app = new Hono();
  let reading = 0;

  const tooLarge = (c: Context) =>
    c.json({ code: "TOO_LARGE", message: "That message is too large." }, 413);
  const later = (c: Context, status: 429 | 503, seconds: number) => {
    c.header("Retry-After", String(seconds));
    return c.json({ code: "TRY_LATER", message: "Send it again later." }, status);
  };
  // One answer for an unknown channel, a missing or wrong signature and a stale one.
  const unauthorised = (c: Context, address: string) => {
    const spent = failures.take(address);
    if (spent) return later(c, 429, spent);
    return c.json({ code: "UNAUTHORIZED", message: "That request wasn't accepted." }, 401);
  };

  app.post("/email/:key", async (c) => {
    c.header("Cache-Control", "no-store");
    const address = options.clientIp(c) ?? "unknown";
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
      return unauthorised(c, address);
    }
    const spent = known.has(key) ? 0 : failures.waiting(address);
    if (spent) return later(c, 429, spent);
    const channel = await channels.open(key);
    if (!channel) {
      known.delete(key);
      return unauthorised(c, address);
    }

    if (Number(c.req.header("content-length") ?? 0) > EMAIL_LIMITS.bytes) return tooLarge(c);
    if (reading >= MAX_CONCURRENT || byAddress.full(address) || byChannel.full(channel.id)) {
      return later(c, 503, 5);
    }
    reading++;
    byAddress.take(address);
    byChannel.take(channel.id);
    try {
      const raw = await readCapped(c.req.raw.body, EMAIL_LIMITS.bytes, idleMs);
      if (raw === "large") return tooLarge(c);
      if (raw === "late") {
        failures.take(address);
        return c.json({ code: "TOO_SLOW", message: "Send it again." }, 408);
      }
      const signed = channel.secrets.some((secret) =>
        verifyTimestamped(
          secret,
          raw,
          { timestamp, signature },
          { now: now(), windowSeconds: WINDOW_SECONDS },
        ),
      );
      if (!signed) return unauthorised(c, address);
      known.add(key);
      const busy = perChannel.take(channel.id);
      if (busy) return later(c, 429, busy);

      const sent = await checkSender(raw, channel.rules);
      const outcome = await channels.receive(
        channel.id,
        raw,
        sent.ok
          ? { fromHash: senderHash(channel.workspaceId, sent.from) }
          : { rejected: sent.reason },
      );
      if (outcome === "unknown") return unauthorised(c, address);
      if (outcome === "full") return later(c, 429, 600);
      // A repeat, or mail that is dropped, is answered as any other: nothing goes back.
      return c.json({ status: "accepted" }, 202);
    } finally {
      reading--;
      byAddress.free(address);
      byChannel.free(channel.id);
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
