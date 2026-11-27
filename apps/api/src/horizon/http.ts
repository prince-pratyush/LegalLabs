import {
  HorizonBulk,
  HorizonRelevance,
  HorizonScanCreate,
  HorizonScanPatch,
  HorizonSettings,
  HorizonStatePatch,
  HorizonTab,
} from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { Limiter } from "../auth/limiter.js";
import type { ActionFailure, ActionResult, HorizonActions } from "./actions.js";
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

const values = z
  .array(
    z
      .string()
      .min(1)
      .max(100)
      .refine((v) => !v.includes("\0")),
  )
  .max(20);
const itemQuery = z.object({
  tab: HorizonTab.default("all"),
  relevance: z.array(HorizonRelevance).max(3),
  type: values,
  source: values,
  jurisdiction: values,
  topic: values,
  industry: values,
  q: z
    .string()
    .max(200)
    .refine((v) => !v.includes("\0"))
    .optional(),
  cursor: z.string().max(100).optional(),
});

const ACTION_FAILURES: Record<ActionFailure, { status: 403 | 404 | 422 | 502; message: string }> = {
  NOT_FOUND: { status: 404, message: "That item wasn't found." },
  FORBIDDEN: { status: 403, message: "You don't have access to do that." },
  DISABLED: { status: 403, message: "Horizon scanning is turned off for this workspace." },
  SOURCE_UNAVAILABLE: {
    status: 502,
    message: "The source didn't give the text just now. Try again shortly.",
  },
  VAULT_NOT_FOUND: { status: 404, message: "That vault or folder wasn't found." },
  MATTER_REQUIRED: {
    status: 422,
    message: "This workspace needs a matter for new threads. Save to a vault instead.",
  },
  UPLOAD_REFUSED: { status: 422, message: "The file couldn't be stored there." },
};

const saveBody = z.strictObject({ vault_id: z.uuid(), folder_id: z.uuid().optional() });
const threadBody = z.strictObject({ matter_id: z.uuid().optional() });

export function horizonHttp(
  horizon: Horizon,
  clientOf: (c: Context) => Client,
  actions?: HorizonActions,
  asks?: Limiter,
) {
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
    const many = (name: string) => c.req.queries(name) ?? [];
    const query = itemQuery.safeParse({
      tab: c.req.query("tab"),
      relevance: many("relevance"),
      type: many("type"),
      source: many("source"),
      jurisdiction: many("jurisdiction"),
      topic: many("topic"),
      industry: many("industry"),
      q: c.req.query("q"),
      cursor: c.req.query("cursor"),
    });
    if (!query.success) return invalid(c);
    const result = await horizon.items(c.get("principal"), c.req.param("id"), query.data);
    return reply(c, result, (page) => c.json(page));
  });

  app.patch("/horizon/items/:id/state", json, async (c) => {
    const parsed = HorizonStatePatch.safeParse(await body(c));
    if (!parsed.success) return invalid(c);
    const result = await horizon.setState(c.get("principal"), c.req.param("id"), parsed.data);
    return reply(c, result, () => c.body(null, 204));
  });

  app.post("/horizon/items/bulk", json, async (c) => {
    const parsed = HorizonBulk.safeParse(await body(c));
    if (!parsed.success) return invalid(c);
    const result = await horizon.bulk(c.get("principal"), parsed.data);
    return reply(c, result, (changed) => c.json(changed));
  });

  if (actions) {
    // Each of these fetches from a source or stores a file, so it counts as an ask.
    const limited = (c: Context<Env>) => {
      const wait = asks?.take(c.get("principal").userId) ?? 0;
      if (wait === 0) return null;
      c.header("Retry-After", String(wait));
      return c.json(
        { code: "TOO_MANY_REQUESTS", message: "You've asked a lot just now. Try again shortly." },
        429,
      );
    };
    const acted = <T>(c: Context, result: ActionResult<T>): Response => {
      if (result.ok) return c.json(result.value as object, 201);
      const { status, message } = ACTION_FAILURES[result.reason];
      return c.json({ code: result.reason, message }, status);
    };

    app.post("/horizon/items/:id/save-to-vault", json, async (c) => {
      const parsed = saveBody.safeParse(await body(c));
      if (!parsed.success) return invalid(c);
      const wait = limited(c);
      if (wait) return wait;
      const { vault_id, folder_id } = parsed.data;
      return acted(
        c,
        await actions.saveToVault(
          c.get("principal"),
          c.req.param("id") as string,
          { vaultId: vault_id, folderId: folder_id ?? null },
          clientOf(c),
        ),
      );
    });

    type Open = (...args: Parameters<HorizonActions["ask"]>) => Promise<ActionResult<object>>;
    const toThread = (path: "ask" | "draft-email", run: Open) =>
      app.post(`/horizon/items/:id/${path}`, json, async (c) => {
        const parsed = threadBody.safeParse((await body(c)) ?? {});
        if (!parsed.success) return invalid(c);
        const wait = limited(c);
        if (wait) return wait;
        return acted(
          c,
          await run(
            c.get("principal"),
            c.req.param("id") as string,
            parsed.data.matter_id ?? null,
            clientOf(c),
          ),
        );
      });
    toThread("ask", actions.ask);
    toThread("draft-email", actions.draftEmail);
  }

  return app;
}
