import { HorizonScanCreate, HorizonScanPatch, HorizonSettings } from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Client, Principal } from "../auth/auth.js";
import type { Horizon, HorizonFailure, HorizonResult } from "./horizon.js";

type Env = { Variables: { principal: Principal } };

export const HORIZON_FAILURES: Record<
  HorizonFailure,
  { status: 400 | 403 | 404 | 409 | 422; message: string }
> = {
  NOT_FOUND: { status: 404, message: "That scan or item wasn't found." },
  FORBIDDEN: { status: 403, message: "You don't have access to do that." },
  DISABLED: { status: 403, message: "Horizon scanning is turned off for this workspace." },
  FROM_DATE_TOO_EARLY: {
    status: 422,
    message: "A scan can start at most 28 days before it was made.",
  },
  FROM_DATE_IN_FUTURE: { status: 422, message: "A scan can't start after today." },
  SOURCE_OUTSIDE_JURISDICTIONS: {
    status: 422,
    message: "A chosen source is outside the chosen jurisdictions.",
  },
  TOO_MANY_SCANS: { status: 409, message: "This workspace already has 100 scans." },
  BAD_CURSOR: { status: 400, message: "Check the request." },
};

export function horizonHttp(horizon: Horizon, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();
  const json = bodyLimit({
    maxSize: 32 * 1024,
    onError: (c) => c.json({ code: "INVALID_REQUEST", message: "The request is too large." }, 400),
  });
  const invalid = (c: Context) =>
    c.json({ code: "INVALID_REQUEST", message: "Check the request." }, 400);
  const body = (c: Context) => c.req.json().catch(() => null);

  const reply = <T>(
    c: Context,
    result: HorizonResult<T>,
    send: (value: T) => Response,
  ): Response => {
    if (result.ok) return send(result.value);
    const { status, message } = HORIZON_FAILURES[result.reason];
    return c.json({ code: result.reason, message }, status);
  };

  app.get("/horizon/settings", async (c) => c.json(await horizon.settings(c.get("principal"))));

  app.put("/horizon/settings", json, async (c) => {
    const parsed = HorizonSettings.safeParse(await body(c));
    if (!parsed.success) return invalid(c);
    const result = await horizon.setEnabled(c.get("principal"), parsed.data.enabled, clientOf(c));
    return reply(c, result, (enabled) => c.json({ enabled }));
  });

  app.get("/horizon/scans", async (c) =>
    reply(c, await horizon.list(c.get("principal")), (scans) => c.json({ scans })),
  );

  app.post("/horizon/scans", json, async (c) => {
    const parsed = HorizonScanCreate.safeParse(await body(c));
    if (!parsed.success) return invalid(c);
    const result = await horizon.create(c.get("principal"), parsed.data, clientOf(c));
    return reply(c, result, (scan) => c.json({ scan }, 201));
  });

  app.get("/horizon/scans/:id", async (c) =>
    reply(c, await horizon.get(c.get("principal"), c.req.param("id")), (scan) => c.json({ scan })),
  );

  app.patch("/horizon/scans/:id", json, async (c) => {
    const parsed = HorizonScanPatch.safeParse(await body(c));
    if (!parsed.success) return invalid(c);
    const result = await horizon.update(
      c.get("principal"),
      c.req.param("id"),
      parsed.data,
      clientOf(c),
    );
    return reply(c, result, (scan) => c.json({ scan }));
  });

  app.delete("/horizon/scans/:id", async (c) => {
    const result = await horizon.remove(c.get("principal"), c.req.param("id"), clientOf(c));
    return reply(c, result, () => c.body(null, 204));
  });

  app.get("/horizon/scans/:id/items", async (c) => {
    const result = await horizon.items(c.get("principal"), c.req.param("id"), {
      cursor: c.req.query("cursor"),
    });
    return reply(c, result, (page) => c.json(page));
  });

  return app;
}
