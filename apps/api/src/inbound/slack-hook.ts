import { type Context, Hono } from "hono";
import { createLimiter } from "../auth/limiter.js";
import type { SlackChannels } from "../intake/slack-channels.js";
import { places, readCapped } from "./body.js";
import { senderHash } from "./email.js";
import { verifyTimestamped } from "./signature.js";
import { readSlack, SLACK_LIMITS, type SlackItem } from "./slack.js";

// The one request URL for a Slack app's events, slash command and message shortcut. As the mail
// hook: no session, every cheap check before the body is read, the signature over the raw
// bytes before anything is parsed, and nothing of what was said in a log. Slack wants an
// answer within three seconds, so a post is only queued here.

export interface SlackHookOptions {
  /** The caller's address, behind any trusted proxy. */
  clientIp: (c: Context) => string | null;
  now?: () => number;
  idleMs?: number;
}

const KEY = /^[A-Za-z0-9_-]{32}$/;
const WINDOW_SECONDS = 300;
// Slack posts for every workspace from the same few addresses, so an address gets more places
// than a channel does, and no one channel can have them all.
const MAX_CONCURRENT = 16;
const MAX_PER_ADDRESS = 8;
const MAX_PER_CHANNEL = 4;
const IDLE_MS = 2000;
const READ_DEADLINE_MS = 5000;

const ephemeral = (text: string) => ({ response_type: "ephemeral", text });

export function slackHook(channels: SlackChannels, options: SlackHookOptions) {
  const { now = Date.now, idleMs = IDLE_MS } = options;
  const failures = createLimiter({ limit: 120, windowMs: 60_000, now });
  const perChannel = createLimiter({ limit: 120, windowMs: 60_000, now });
  // Within a channel's minute, so one person cannot use it all up.
  const perSender = createLimiter({ limit: 30, windowMs: 60_000, now });
  /** Keys that have signed correctly, which a run of junk does not keep from being looked up. */
  const known = new Set<string>();
  const byAddress = places(MAX_PER_ADDRESS);
  const byChannel = places(MAX_PER_CHANNEL);
  const app = new Hono();
  let reading = 0;

  const tooLarge = (c: Context) =>
    c.json({ code: "TOO_LARGE", message: "That message is too large." }, 413);
  const later = (c: Context, status: 429 | 503, seconds: number) => {
    c.header("Retry-After", String(seconds));
    return c.json({ code: "TRY_LATER", message: "Send it again later." }, status);
  };
  const unauthorised = (c: Context, address: string) => {
    const spent = failures.take(address);
    if (spent) return later(c, 429, spent);
    return c.json({ code: "UNAUTHORIZED", message: "That request wasn't accepted." }, 401);
  };
  /** Taken and dropped alike: Slack counts anything else as a failed delivery. */
  const done = (c: Context) => c.body(null, 200);

  app.post("/slack/:key", async (c) => {
    c.header("Cache-Control", "no-store");
    const address = options.clientIp(c) ?? "unknown";
    const key = c.req.param("key");
    const timestamp = c.req.header("x-slack-request-timestamp");
    const signature = c.req.header("x-slack-signature");
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

    if (Number(c.req.header("content-length") ?? 0) > SLACK_LIMITS.bytes) return tooLarge(c);
    if (reading >= MAX_CONCURRENT || byAddress.full(address) || byChannel.full(channel.id)) {
      return later(c, 503, 5);
    }
    reading++;
    byAddress.take(address);
    byChannel.take(channel.id);
    try {
      const raw = await readCapped(c.req.raw.body, {
        max: SLACK_LIMITS.bytes,
        idleMs,
        deadlineMs: READ_DEADLINE_MS,
      });
      if (raw === "large") return tooLarge(c);
      if (raw === "late") {
        failures.take(address);
        return c.json({ code: "TOO_SLOW", message: "Send it again." }, 408);
      }
      const signed = verifyTimestamped(
        channel.signingSecret,
        raw,
        { timestamp, signature },
        { now: now(), windowSeconds: WINDOW_SECONDS },
      );
      if (!signed) return unauthorised(c, address);
      known.add(key);

      const post = readSlack(raw);
      if (post.kind === "challenge") return c.json({ challenge: post.challenge });
      if (post.kind === "ignore" || post.team !== channel.teamId) return done(c);
      if (post.kind === "empty_command") {
        return c.json(ephemeral("Add what you need after the command."));
      }
      const { item } = post;
      // A new request only where the channel is set up. An answer is matched to its thread,
      // which may be a direct conversation, by the database.
      if (!item.reply && !channel.channelIds.includes(item.channel)) {
        return item.source === "command"
          ? c.json(ephemeral("This command isn't set up for this channel."))
          : done(c);
      }
      const thread = item.reply
        ? { channel: item.channel, threadTs: item.threadTs, user: item.user }
        : null;
      // Talk in a thread that is no request's of this person's is dropped before it counts
      // against anyone's minute.
      if (thread && !(await channels.awaits(channel.id, thread))) return done(c);
      const busy = perSender.take(`${channel.id}:${item.user}`) || perChannel.take(channel.id);
      if (busy) return later(c, 429, busy);
      const outcome = await channels.receive(
        channel.id,
        queued(item),
        senderHash(channel.workspaceId, item.user),
        thread,
      );
      if (outcome === "unknown") return unauthorised(c, address);
      if (outcome === "full") return later(c, 429, 600);
      return item.source === "command"
        ? c.json(
            ephemeral("Thanks. The legal team has your request, and we will message you about it."),
          )
        : done(c);
    } finally {
      reading--;
      byAddress.free(address);
      byChannel.free(channel.id);
    }
  });

  // A database error quotes the row it refused, which here is the message.
  app.onError((err, c) => {
    const { code } = err as { code?: string };
    console.error(`slack hook failed: ${code ?? err.name}`);
    return c.json({ code: "FAILED", message: "Send it again later." }, 500);
  });

  return app;
}

/**
 * What is queued: only what is used. The same message sent twice, or as two kinds of event,
 * differs in nothing that is kept apart from its files, and is told apart again when read.
 */
const queued = (item: SlackItem) => Buffer.from(JSON.stringify(item));
