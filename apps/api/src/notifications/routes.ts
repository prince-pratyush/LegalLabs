import {
  AdminNotificationSettingsPatch,
  NotificationActBody,
  NotificationPatch,
  NotificationQuery,
  NotificationSettingsPatch,
} from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { Client, Principal } from "../auth/auth.js";
import type { Notifications } from "./notifications.js";

type Env = { Variables: { principal: Principal } };

const POLL_MS = 5_000;
const MAX_STREAM_MS = 30 * 60_000;
const MAX_STREAMS = 10;

const small = bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) =>
    c.json({ code: "INVALID_REQUEST", message: "Check the details and try again." }, 400),
});
const invalid = (c: Context) =>
  c.json({ code: "INVALID_REQUEST", message: "Check the details and try again." }, 400);
const notFound = (c: Context) =>
  c.json({ code: "NOT_FOUND", message: "That notification wasn't found." }, 404);

export function notificationRoutes(
  notifications: Notifications,
  clientOf: (c: Context) => Client,
  options: { now?: () => number; pollMs?: number } = {},
) {
  const app = new Hono<Env>();
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? POLL_MS;
  const streams = new Map<string, number>();

  app.get("/notifications", async (c) => {
    const query = NotificationQuery.safeParse(c.req.query());
    if (!query.success) return invalid(c);
    return c.json(await notifications.list(c.get("principal"), query.data));
  });

  app.get("/notifications/unread-count", async (c) => {
    const counts = await notifications.counts(c.get("principal"));
    return c.json(counts);
  });

  app.post("/notifications/read-all", async (c) => {
    await notifications.readAll(c.get("principal"));
    return c.body(null, 204);
  });

  app.get("/notifications/stream", async (c) => {
    const principal = c.get("principal");
    const open = streams.get(principal.userId) ?? 0;
    if (open >= MAX_STREAMS) {
      return c.json({ code: "TOO_MANY_STREAMS", message: "Close another tab first." }, 429);
    }
    streams.set(principal.userId, open + 1);
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let wake: (() => void) | null = null;
      // A publish only wakes the loop; what to send is always read back as the caller.
      const stop = notifications.hub.subscribe(principal.userId, () => wake?.());
      stream.onAbort(() => wake?.());
      const opened = now();
      const sent = new Set<string>();
      let since: string | null = null;
      let lastCounts = "";
      try {
        while (!stream.aborted && now() - opened < MAX_STREAM_MS) {
          const { items, counts, high } = await notifications.changes(principal, since);
          since = high;
          for (const item of items) {
            const key = `${item.id}|${item.created_at}`;
            if (sent.has(key)) continue;
            sent.add(key);
            await stream.writeSSE({
              event: "notification",
              data: JSON.stringify({ notification: item }),
            });
          }
          if (sent.size > 500) sent.clear();
          const text = JSON.stringify(counts);
          if (text !== lastCounts || items.length > 0) {
            lastCounts = text;
            await stream.writeSSE({ event: "counts", data: text });
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, pollMs);
          });
          clearTimeout(timer);
          wake = null;
          if (!stream.aborted) await stream.write(": keep-alive\n\n");
        }
      } finally {
        stop();
        const left = (streams.get(principal.userId) ?? 1) - 1;
        if (left > 0) streams.set(principal.userId, left);
        else streams.delete(principal.userId);
      }
    });
  });

  app.get("/notifications/:id", async (c) => {
    const found = await notifications.get(c.get("principal"), c.req.param("id"));
    return found ? c.json({ notification: found }) : notFound(c);
  });

  app.patch("/notifications/:id", small, async (c) => {
    const body = NotificationPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const found = await notifications.patch(c.get("principal"), c.req.param("id"), body.data);
    return found ? c.json({ notification: found }) : notFound(c);
  });

  app.post("/notifications/:id/act", small, async (c) => {
    const body = NotificationActBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const out = await notifications.act(
      c.get("principal"),
      c.req.param("id"),
      body.data,
      clientOf(c),
    );
    if (out.ok) return c.json({ ...out.result, notification: out.notification });
    if (out.reason === "REFUSED")
      return c.json({ code: out.code, message: out.message }, out.status);
    if (out.reason === "NOT_FOUND") return notFound(c);
    return c.json(
      {
        code: out.reason,
        message:
          out.reason === "UNKNOWN_ACTION"
            ? "That action isn't available for this notification."
            : "That action can't be taken from here yet. Open the item instead.",
      },
      out.reason === "UNKNOWN_ACTION" ? 400 : 409,
    );
  });

  app.get("/notification-settings", async (c) =>
    c.json(await notifications.settings(c.get("principal"))),
  );

  app.patch("/notification-settings", small, async (c) => {
    const body = NotificationSettingsPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const out = await notifications.patchSettings(c.get("principal"), body.data, clientOf(c));
    return out.ok
      ? c.json(out.settings)
      : c.json(
          { code: "INVALID_TZ", message: "Choose a time zone such as Australia/Sydney." },
          400,
        );
  });

  app.get("/admin/notification-settings", async (c) => {
    const found = await notifications.adminSettings(c.get("principal"));
    return found
      ? c.json(found)
      : c.json(
          { code: "FORBIDDEN", message: "You can't change workspace notification settings." },
          403,
        );
  });

  app.patch("/admin/notification-settings", small, async (c) => {
    const body = AdminNotificationSettingsPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const found = await notifications.patchAdminSettings(
      c.get("principal"),
      body.data,
      clientOf(c),
    );
    return found
      ? c.json(found)
      : c.json(
          { code: "FORBIDDEN", message: "You can't change workspace notification settings." },
          403,
        );
  });

  return app;
}
