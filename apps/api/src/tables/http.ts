import {
  AddRowsBody,
  BulkCellsBody,
  CreateColumnBody,
  CreateTableBody,
  EstimateBody,
  ExportBody,
  GenerateColumnsBody,
  PatchCellBody,
  PatchColumnBody,
  PatchTableBody,
  PutSyncBody,
  parseSort,
  ReorderColumnsBody,
  RerunCellBody,
  RowFilter,
  RT_LIMITS,
  RunColumnBody,
  RunTableBody,
  type TableErrorCode,
} from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { Limiter } from "../auth/limiter.js";
import type { Cells } from "./cells.js";
import type { Exports } from "./export.js";
import type { Runner } from "./runner.js";
import type { TableSync } from "./sync.js";
import type { Failure, Result, Tables } from "./tables.js";

type Env = { Variables: { principal: Principal } };

export interface TableHttpOptions {
  tables: Tables;
  cells: Cells;
  exports: Exports;
  runner: Runner;
  sync: TableSync;
  clientOf: (c: Context) => Client;
  /** The same budget of model calls as thread questions and playbook drafting. */
  asks?: Limiter;
}

const STATUS: Record<TableErrorCode, 400 | 403 | 404 | 409 | 502> = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  COLUMN_CYCLE: 409,
  COLUMN_REFERENCED: 409,
  SYNC_ENABLED: 409,
  SYNC_DISABLED: 409,
  SYNC_UNAVAILABLE: 409,
  SOURCE_REMOVED: 409,
  SOURCE_LIMIT: 409,
  SOURCE_MISMATCH: 400,
  SOURCE_MIXED: 400,
  SOURCE_EMPTY: 400,
  COLUMN_LIMIT: 409,
  COLUMN_RUNNING: 409,
  COLUMN_MANUAL: 409,
  CONTEXT_FILE_SOURCE_MISMATCH: 400,
  CELL_LOCKED: 409,
  EXPORT_DISABLED_BY_SOURCE: 403,
  MODEL_NOT_ALLOWED: 403,
  MODEL_UNAVAILABLE: 502,
  EXPORT_TOO_LARGE: 409,
};

const MESSAGES: Partial<Record<TableErrorCode, string>> = {
  NOT_FOUND: "That wasn't found.",
  INVALID_REQUEST: "Check the request.",
  MODEL_NOT_ALLOWED: "That model isn't available to you.",
};

const failure = (c: Context, f: Failure) =>
  c.json(
    {
      code: f.code,
      message: f.message ?? MESSAGES[f.code] ?? f.code,
      ...(f.details ? { details: f.details } : {}),
    },
    STATUS[f.code],
  );

const invalid = (c: Context, message = "Check the request.") =>
  c.json({ code: "INVALID_REQUEST", message }, 400);

async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S> | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

const send = <T>(c: Context, result: Result<T>, status: 200 | 201 | 202 = 200) =>
  result.ok ? c.json(result.value as object, status) : failure(c, result);

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const offsetOf = (cursor: string | undefined) => {
  const n = Number(cursor ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

export function tableHttp({
  tables,
  cells,
  exports,
  runner,
  sync,
  clientOf,
  asks,
}: TableHttpOptions) {
  const app = new Hono<Env>();
  const limit = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => invalid(c) });
  const p = (c: Context<Env>) => c.get("principal");

  app.post("/review-tables", limit, async (c) => {
    const parsed = await body(c, CreateTableBody);
    if (!parsed) return invalid(c);
    return send(c, await tables.create(p(c), parsed, clientOf(c)), 201);
  });

  app.get("/review-tables", async (c) => {
    const offset = offsetOf(c.req.query("cursor"));
    if (offset === null) return invalid(c);
    const q = c.req.query("q");
    return c.json(
      await tables.list(p(c), {
        starred: (c.req.query("filter[starred]") ?? c.req.query("starred")) === "true",
        ...(q ? { q: q.slice(0, 200) } : {}),
        offset,
      }),
    );
  });

  app.get("/review-tables/:id", async (c) => send(c, await tables.get(p(c), c.req.param("id"))));

  app.patch("/review-tables/:id", limit, async (c) => {
    const parsed = await body(c, PatchTableBody);
    if (!parsed) return invalid(c);
    return send(c, await tables.update(p(c), c.req.param("id"), parsed, clientOf(c)));
  });

  app.delete("/review-tables/:id", async (c) => {
    const result = await tables.remove(p(c), c.req.param("id"), clientOf(c));
    return result.ok ? c.body(null, 202) : failure(c, result);
  });

  for (const [method, on] of [
    ["post", true],
    ["delete", false],
  ] as const) {
    app[method]("/review-tables/:id/star", async (c) => {
      const result = await tables.star(p(c), c.req.param("id"), on, clientOf(c));
      return result.ok ? c.body(null, 204) : failure(c, result);
    });
  }

  app.get("/review-tables/:id/rows", async (c) => {
    const offset = offsetOf(c.req.query("cursor"));
    const size = Number(c.req.query("limit") ?? RT_LIMITS.rowsPage);
    if (offset === null || !Number.isInteger(size) || size < 1 || size > RT_LIMITS.rowsPage) {
      return invalid(c);
    }
    let filter: z.infer<typeof RowFilter> | undefined;
    const rawFilter = c.req.query("filter");
    if (rawFilter) {
      let json: unknown;
      try {
        json = JSON.parse(rawFilter);
      } catch {
        return invalid(c, "filter must be JSON.");
      }
      const parsed = RowFilter.safeParse(json);
      if (!parsed.success) return invalid(c, "Check the filter.");
      filter = parsed.data;
    }
    const rawSort = c.req.query("sort");
    const sort = rawSort ? parseSort(rawSort) : null;
    if (rawSort && !sort) return invalid(c, "sort is column_id:asc or column_id:desc.");
    return send(
      c,
      await cells.rows(p(c), c.req.param("id"), {
        ...(filter ? { filter } : {}),
        sort,
        limit: size,
        offset,
      }),
    );
  });

  app.post("/review-tables/:id/rows", limit, async (c) => {
    const parsed = await body(c, AddRowsBody);
    if (!parsed) return invalid(c);
    return send(c, await tables.addRows(p(c), c.req.param("id"), parsed, clientOf(c)), 201);
  });

  app.post("/review-tables/:id/columns", limit, async (c) => {
    const parsed = await body(c, CreateColumnBody);
    if (!parsed) return invalid(c, "Check the column's label, type, prompt and options.");
    return send(c, await tables.createColumn(p(c), c.req.param("id"), parsed, clientOf(c)), 201);
  });

  app.post("/review-tables/:id/columns/reorder", limit, async (c) => {
    const parsed = await body(c, ReorderColumnsBody);
    if (!parsed) return invalid(c);
    const result = await tables.reorder(p(c), c.req.param("id"), parsed.column_ids, clientOf(c));
    return result.ok ? c.body(null, 204) : failure(c, result);
  });

  app.post("/review-tables/:id/columns/generate", limit, async (c) => {
    const parsed = await body(c, GenerateColumnsBody);
    if (!parsed) return invalid(c);
    // Checked after the body is valid, so a malformed request doesn't use up an ask.
    const wait = asks?.take(p(c).userId) ?? 0;
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json(
        { code: "TOO_MANY_REQUESTS", message: "You've asked a lot just now. Try again shortly." },
        429,
      );
    }
    return send(
      c,
      await cells.generate(p(c), c.req.param("id"), parsed.description, parsed.max_columns),
    );
  });

  app.patch("/review-tables/:id/columns/:col", limit, async (c) => {
    const parsed = await body(c, PatchColumnBody);
    if (!parsed) return invalid(c);
    return send(
      c,
      await tables.updateColumn(p(c), c.req.param("id"), c.req.param("col"), parsed, clientOf(c)),
    );
  });

  app.delete("/review-tables/:id/columns/:col", async (c) => {
    const result = await tables.removeColumn(
      p(c),
      c.req.param("id"),
      c.req.param("col"),
      clientOf(c),
    );
    if (!result.ok) return failure(c, result);
    if (result.value.run_id) await runner.cancel(p(c), result.value.run_id, clientOf(c));
    return c.body(null, 202);
  });

  app.post("/review-tables/:id/columns/:col/run", limit, async (c) => {
    const parsed = await body(c, RunColumnBody);
    if (!parsed) return invalid(c);
    return send(
      c,
      await cells.runColumn(
        p(c),
        c.req.param("id"),
        c.req.param("col"),
        parsed.scope,
        parsed.include_verified,
        clientOf(c),
        {
          sort: parsed.sort,
          filter: parsed.filter,
          includeDependents: parsed.include_dependents,
        },
      ),
      202,
    );
  });

  app.post("/review-tables/:id/run", limit, async (c) => {
    const parsed = await body(c, RunTableBody);
    if (!parsed) return invalid(c);
    return send(c, await cells.runTable(p(c), c.req.param("id"), parsed.scope, clientOf(c)), 202);
  });

  app.post("/review-tables/:id/estimate", limit, async (c) => {
    const parsed = await body(c, EstimateBody);
    if (!parsed) return invalid(c);
    return send(
      c,
      await cells.estimate(
        p(c),
        c.req.param("id"),
        parsed.column_ids,
        parsed.scope,
        parsed.include_verified,
      ),
    );
  });

  app.post("/review-tables/:id/cells/bulk", limit, async (c) => {
    const parsed = await body(c, BulkCellsBody);
    if (!parsed) return invalid(c);
    return send(c, await cells.bulk(p(c), c.req.param("id"), parsed, clientOf(c)), 202);
  });

  app.get("/review-tables/:id/cells/:cell", async (c) =>
    send(c, await cells.get(p(c), c.req.param("id"), c.req.param("cell"))),
  );

  app.patch("/review-tables/:id/cells/:cell", limit, async (c) => {
    const parsed = await body(c, PatchCellBody);
    if (!parsed) return invalid(c);
    return send(
      c,
      await cells.patch(p(c), c.req.param("id"), c.req.param("cell"), parsed, clientOf(c)),
    );
  });

  app.post("/review-tables/:id/cells/:cell/rerun", limit, async (c) => {
    // The body is optional: a bare POST re-runs the cell alone.
    const text = await c.req.text();
    const parsed = RerunCellBody.safeParse(text.trim() === "" ? {} : safeJson(text));
    if (!parsed.success) return invalid(c);
    return send(
      c,
      await cells.rerun(p(c), c.req.param("id"), c.req.param("cell"), clientOf(c), {
        includeDependents: parsed.data.include_dependents,
        includeVerified: parsed.data.include_verified,
      }),
      202,
    );
  });

  app.get("/review-tables/:id/sync", async (c) =>
    send(c, await sync.status(p(c), c.req.param("id"))),
  );

  app.put("/review-tables/:id/sync", limit, async (c) => {
    const parsed = await body(c, PutSyncBody);
    if (!parsed) return invalid(c, "Check the sync mode and folders.");
    return send(c, await sync.configure(p(c), c.req.param("id"), parsed, clientOf(c)));
  });

  app.post("/review-tables/:id/sync/run", async (c) =>
    send(c, await sync.run(p(c), c.req.param("id"), clientOf(c))),
  );

  app.post("/review-tables/:id/export", limit, async (c) => {
    const parsed = await body(c, ExportBody);
    if (!parsed) return invalid(c);
    const result = await exports.run(p(c), c.req.param("id"), parsed, clientOf(c));
    if (!result.ok) return failure(c, result);
    const { filename, contentType, bytes } = result.value;
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    });
  });

  // Table runs are cancelled here so their queued cells go back to waiting; thread runs
  // fall through to the thread routes mounted after this.
  app.post("/runs/:id/cancel", async (c, next) => {
    if (await runner.cancel(p(c), c.req.param("id"), clientOf(c))) return c.body(null, 202);
    await next();
  });

  return app;
}
