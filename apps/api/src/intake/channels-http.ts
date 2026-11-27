import {
  IntakeEmailChannelCreate,
  IntakeEmailChannelPatch,
  IntakeSecretRotate,
} from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { ChannelFailure, ChannelResult, EmailChannels } from "./channels.js";

type Env = { Variables: { principal: Principal } };

const FAILURES: Record<ChannelFailure, { status: 403 | 404 | 409 | 503; message: string }> = {
  FORBIDDEN: { status: 403, message: "You don't have access to do that." },
  NOT_FOUND: { status: 404, message: "That channel wasn't found." },
  NAME_TAKEN: { status: 409, message: "There is already a channel with that name." },
  TOO_MANY_CHANNELS: { status: 409, message: "This workspace has as many channels as it can." },
  SECRETS_UNAVAILABLE: { status: 503, message: "This server can't store secrets yet." },
};

export function emailChannelHttp(channels: EmailChannels, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();
  const limitBody = bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => c.json({ code: "TOO_LARGE", message: "That request is too large." }, 413),
  });
  async function parse<T extends z.ZodType>(c: Context, schema: T) {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (parsed.success) return { data: parsed.data as z.output<T> };
    const details = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path, code: i.code }));
    return {
      response: c.json({ code: "INVALID_REQUEST", message: "Check the request.", details }, 400),
    };
  }
  const reply = <T>(
    c: Context,
    result: ChannelResult<T>,
    body: (value: T) => object,
    status: 200 | 201 = 200,
  ) => {
    if (result.ok) return c.json(body(result.value), status);
    const failure = FAILURES[result.reason];
    return c.json({ code: result.reason, message: failure.message }, failure.status);
  };
  const me = (c: Context<Env>) => c.get("principal");
  const id = (c: Context<Env>) => c.req.param("id") ?? "";

  app.get("/apps/intake/channels", async (c) =>
    reply(c, await channels.list(me(c)), (list) => ({ channels: list })),
  );

  app.post("/apps/intake/channels", limitBody, async (c) => {
    const body = await parse(c, IntakeEmailChannelCreate);
    if (!("data" in body)) return body.response;
    return reply(c, await channels.create(me(c), body.data, clientOf(c)), (made) => made, 201);
  });

  app.patch("/apps/intake/channels/:id", limitBody, async (c) => {
    const body = await parse(c, IntakeEmailChannelPatch);
    if (!("data" in body)) return body.response;
    const result = await channels.update(me(c), id(c), body.data, clientOf(c));
    return reply(c, result, (channel) => ({ channel }));
  });

  app.post("/apps/intake/channels/:id/rotate-secret", limitBody, async (c) => {
    const body = await parse(c, IntakeSecretRotate);
    if (!("data" in body)) return body.response;
    const result = await channels.rotate(me(c), id(c), body.data.grace_hours, clientOf(c));
    return reply(c, result, (made) => made);
  });

  return app;
}
