import {
  ImportMode,
  MATTER_LIMITS,
  MatterCreate,
  MatterOptions,
  MatterPatch,
  WallCreate,
  WallEvaluateRequest,
  WallProviderConfig,
} from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { MatterFailure, Matters, Result } from "./matters.js";

type Env = { Variables: { principal: Principal } };

const FAILURES: Record<MatterFailure, { status: 400 | 403 | 404 | 409 | 413; message: string }> = {
  NOT_FOUND: { status: 404, message: "That wasn't found." },
  FORBIDDEN: { status: 403, message: "You don't have permission to do that." },
  INVALID_REQUEST: { status: 400, message: "Check the details and try again." },
  ID_REGEX_MISMATCH: {
    status: 400,
    message: "The matter number doesn't match this workspace's id pattern.",
  },
  MATTER_EXISTS: { status: 409, message: "A matter with this client id and number exists." },
  INVALID_CSV: { status: 400, message: "That file couldn't be read as CSV." },
  IMPORT_EXPIRED: {
    status: 409,
    message: "This preview has expired or was applied. Upload again.",
  },
  WALL_EXISTS: { status: 409, message: "That wall row already exists." },
  WALL_SYNCED: {
    status: 409,
    message: "This row comes from a provider. Change it there, or upload a new file.",
  },
  INVALID_PRINCIPAL: { status: 400, message: "Choose a person or group in this workspace." },
  TOO_MANY_UNRESOLVED: {
    status: 400,
    message: "More than 10% of the rows couldn't be matched, so nothing was imported.",
  },
  PROVIDER_NOT_SUPPORTED: { status: 400, message: "That provider isn't available yet." },
};

const invalid = (c: Context) =>
  c.json({ code: "INVALID_REQUEST", message: FAILURES.INVALID_REQUEST.message }, 400);

function send<T>(c: Context, result: Result<T>, ok: (value: T) => Response) {
  if (result.ok) return ok(result.value);
  const failure = FAILURES[result.reason];
  return c.json(
    { code: result.reason, message: result.message ?? failure.message },
    failure.status,
  );
}

async function json<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

const small = bodyLimit({ maxSize: 64 * 1024, onError: (c) => invalid(c) });
const upload = bodyLimit({
  maxSize: MATTER_LIMITS.importBytes + 64 * 1024,
  onError: (c) => c.json({ code: "TOO_LARGE", message: "A file can be up to 20 MB." }, 413),
});

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(["active", "closed"]).optional(),
  allow_in_queries: z.enum(["true", "false"]).optional(),
  scope: z.enum(["all", "picker"]).optional(),
  cursor: z.coerce.number().int().min(0).max(10_000_000).optional(),
});
const currentBody = z.object({ matter_id: z.uuid().nullable() }).strict();
const wallQuery = z.object({
  matter_id: z.uuid().optional(),
  principal_id: z.uuid().optional(),
  provider: z.enum(["internal", "csv", "intapp", "imanage_spm"]).optional(),
});

/** The uploaded file as text; UTF-8 only, as the schema says. */
async function readUpload(c: Context): Promise<{ text: string; form: FormData } | null> {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !(file instanceof File) || file.size > MATTER_LIMITS.importBytes) return null;
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()),
      form,
    };
  } catch {
    return null;
  }
}

const csvResponse = (c: Context, csv: string, name: string) =>
  c.body(csv, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${name}"`,
  });

export function matterRoutes(matters: Matters, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();
  const me = (c: Context<Env>) => c.get("principal");

  app.get("/matters", async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c);
    const q = parsed.data;
    const page = await matters.list(me(c), {
      ...(q.q ? { q: q.q } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.allow_in_queries ? { allowInQueries: q.allow_in_queries === "true" } : {}),
      ...(q.scope === "picker" ? { picker: true } : {}),
      ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
    });
    return c.json({ items: page.items, next_cursor: page.nextCursor });
  });

  app.post("/matters", small, async (c) => {
    const input = await json(c, MatterCreate);
    if (!input) return invalid(c);
    return send(c, await matters.create(me(c), input, clientOf(c)), (matter) =>
      c.json({ matter }, 201),
    );
  });

  app.post("/matters/import", upload, async (c) => {
    const uploaded = await readUpload(c);
    const mode = ImportMode.safeParse(uploaded?.form.get("mode") ?? "upsert");
    if (!uploaded || !mode.success) return invalid(c);
    return send(
      c,
      await matters.importPreview(me(c), uploaded.text, mode.data, clientOf(c)),
      (preview) => c.json(preview),
    );
  });

  app.post("/matters/import/:token/apply", async (c) =>
    send(c, await matters.importApply(me(c), c.req.param("token"), clientOf(c)), (value) =>
      c.json(value),
    ),
  );

  app.get("/matters/import/:token/report", async (c) => {
    const report = await matters.importReport(me(c), c.req.param("token"));
    if (report === null) return c.json({ code: "NOT_FOUND", message: "That wasn't found." }, 404);
    return csvResponse(c, report, "matter-import-result.csv");
  });

  // Before "/matters/:id", so "current" is never read as an id.
  app.get("/matters/current", async (c) => c.json({ matter: await matters.current(me(c)) }));
  app.put("/matters/current", small, async (c) => {
    const input = await json(c, currentBody);
    if (!input) return invalid(c);
    return send(c, await matters.setCurrent(me(c), input.matter_id), (matter) =>
      c.json({ matter }),
    );
  });

  app.get("/matters/:id", async (c) => {
    const matter = await matters.get(me(c), c.req.param("id"));
    return matter
      ? c.json({ matter })
      : c.json({ code: "NOT_FOUND", message: FAILURES.NOT_FOUND.message }, 404);
  });

  app.patch("/matters/:id", small, async (c) => {
    const input = await json(c, MatterPatch);
    if (!input || Object.keys(input).length === 0) return invalid(c);
    return send(c, await matters.update(me(c), c.req.param("id"), input, clientOf(c)), (matter) =>
      c.json({ matter }),
    );
  });

  app.post("/matters/:id/close", async (c) =>
    send(c, await matters.close(me(c), c.req.param("id"), clientOf(c)), (matter) =>
      c.json({ matter }),
    ),
  );

  app.post("/matters/:id/acknowledge", async (c) => {
    const ack = await matters.acknowledge(me(c), c.req.param("id"), clientOf(c));
    return ack
      ? c.json(ack)
      : c.json({ code: "NOT_FOUND", message: FAILURES.NOT_FOUND.message }, 404);
  });

  app.get("/matters/:id/acknowledgements", async (c) =>
    send(c, await matters.acknowledgements(me(c), c.req.param("id")), (items) => c.json({ items })),
  );

  app.get("/admin/matters/options", async (c) => c.json(await matters.options(me(c))));
  app.put("/admin/matters/options", small, async (c) => {
    const input = await json(c, MatterOptions);
    if (!input) return invalid(c);
    return send(c, await matters.setOptions(me(c), input, clientOf(c)), (options) =>
      c.json(options),
    );
  });

  app.get("/admin/walls", async (c) => {
    const parsed = wallQuery.safeParse({
      matter_id: c.req.query("filter[matter_id]"),
      principal_id: c.req.query("filter[principal_id]"),
      provider: c.req.query("filter[provider]"),
    });
    if (!parsed.success) return invalid(c);
    const f = parsed.data;
    return send(
      c,
      await matters.walls(me(c), {
        ...(f.matter_id ? { matterId: f.matter_id } : {}),
        ...(f.principal_id ? { principalId: f.principal_id } : {}),
        ...(f.provider ? { provider: f.provider } : {}),
      }),
      (items) => c.json({ items, next_cursor: null }),
    );
  });

  app.post("/admin/walls", small, async (c) => {
    const input = await json(c, WallCreate);
    if (!input) return invalid(c);
    return send(c, await matters.createWall(me(c), input, clientOf(c)), (wall) =>
      c.json({ wall }, 201),
    );
  });

  app.get("/admin/walls/principals", async (c) => {
    const q = z.string().trim().min(1).max(100).safeParse(c.req.query("q"));
    if (!q.success) return invalid(c);
    return send(c, await matters.principals(me(c), q.data), (items) => c.json({ items }));
  });

  app.post("/admin/walls/import", upload, async (c) => {
    const uploaded = await readUpload(c);
    if (!uploaded) return invalid(c);
    const result = await matters.wallImportPreview(me(c), uploaded.text, clientOf(c));
    if (result.ok && !result.value.accepted) {
      return c.json(
        {
          code: "TOO_MANY_UNRESOLVED",
          message: FAILURES.TOO_MANY_UNRESOLVED.message,
          ...result.value,
        },
        400,
      );
    }
    return send(c, result, (preview) => c.json(preview));
  });

  app.post("/admin/walls/import/:token/apply", async (c) =>
    send(c, await matters.wallImportApply(me(c), c.req.param("token"), clientOf(c)), (value) =>
      c.json(value),
    ),
  );

  app.get("/admin/walls/provider", async (c) =>
    send(c, await matters.provider(me(c)), (provider) => c.json(provider)),
  );
  app.put("/admin/walls/provider", small, async (c) => {
    const input = await json(c, WallProviderConfig);
    if (!input) return invalid(c);
    return send(c, await matters.setProvider(me(c), input, clientOf(c)), (provider) =>
      c.json(provider),
    );
  });
  app.get("/admin/walls/provider/syncs", async (c) =>
    send(c, await matters.syncs(me(c)), (items) => c.json({ items })),
  );

  app.post("/admin/walls/evaluate", small, async (c) => {
    const input = await json(c, WallEvaluateRequest);
    if (!input) return invalid(c);
    return send(
      c,
      await matters.evaluate(me(c), input.user_id, input.matter_id, clientOf(c)),
      (result) => c.json(result),
    );
  });

  app.delete("/admin/walls/:id", async (c) =>
    send(c, await matters.removeWall(me(c), c.req.param("id"), clientOf(c)), () =>
      c.body(null, 204),
    ),
  );

  return app;
}
