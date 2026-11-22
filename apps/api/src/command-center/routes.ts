import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { WorkflowType } from "./record.js";
import {
  type CommandCenter,
  CommandCenterError,
  type Filters,
  type ReportChart,
  WORKFLOW_TYPES,
} from "./service.js";

type Env = { Variables: { principal: Principal } };

const small = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) =>
    c.json({ code: "INVALID_REQUEST", message: "Check the details and try again." }, 400),
});
const invalid = (c: Context) =>
  c.json({ code: "INVALID_REQUEST", message: "Check the details and try again." }, 400);

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)));
const ids = z.array(z.string().uuid()).max(100);
const list = (max = 100) => z.array(z.string().trim().min(1).max(120)).max(max);

// ?a=1&a=2 and ?a=1,2 both read as a list.
const multi = (c: Context, name: string) =>
  c.req
    .queries(name)
    ?.flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);

const rangeQuery = z
  .object({ from: day.optional(), to: day.optional() })
  .refine((r) => (r.from === undefined) === (r.to === undefined));

const filterQuery = z.object({
  groups: ids.optional(),
  roles: ids.optional(),
  practice_areas: list().optional(),
});

function parseRange(c: Context) {
  const r = rangeQuery.safeParse({ from: c.req.query("from"), to: c.req.query("to") });
  if (!r.success) return null;
  return r.data.from && r.data.to ? { from: r.data.from, to: r.data.to } : undefined;
}

function parseFilters(c: Context): Filters | null {
  const r = filterQuery.safeParse({
    groups: multi(c, "groups"),
    roles: multi(c, "roles"),
    practice_areas: multi(c, "practice_areas"),
  });
  if (!r.success) return null;
  return {
    ...(r.data.groups ? { groups: r.data.groups } : {}),
    ...(r.data.roles ? { roles: r.data.roles } : {}),
    ...(r.data.practice_areas ? { practiceAreas: r.data.practice_areas } : {}),
  };
}

const grouping = z.enum(["day", "week", "month"]);
const granularity = z.enum(["day", "week"]);
const userSort = z.enum([
  "name",
  "email",
  "role",
  "active_days",
  "total_activity",
  "threads",
  "follow_ups",
  "agent_runs",
  "playbook_runs",
  "rt_columns",
  "word",
  "outlook",
  "last_active",
]);
const usersQuery = z.object({
  sort: userSort.optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).max(100_000).optional(),
  page_size: z.coerce.number().int().min(1).max(200).optional(),
});

const baselineBody = z.object({
  hours: z.number().min(0).max(1000),
  note: z
    .string()
    .max(500)
    .refine((v) => !v.includes("\0"))
    .optional(),
});
const exportBody = z.object({
  from: day,
  to: day,
  surfaces: z.array(z.string().max(40)).max(9).optional(),
  include_former: z.boolean().optional(),
});

const CSV_CHARTS = new Set<string>([
  "monthly_returning",
  "surface_usage",
  "active_users",
  "power_users",
  "queries_over_time",
  "practice_areas",
  "job_titles",
  "outcomes",
  "users",
]);

export function commandCenterRoutes(center: CommandCenter, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();
  const base = "/admin/analytics";

  app.onError((err, c) => {
    if (err instanceof CommandCenterError) {
      return c.json({ code: err.code, message: err.message }, err.status);
    }
    throw err;
  });

  const csv = (c: Context, file: { filename: string; text: string }) =>
    c.body(file.text, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file.filename}"`,
    });

  app.get(`${base}/overview`, async (c) => {
    const range = parseRange(c);
    const g = grouping.safeParse(c.req.query("grouping") ?? "day");
    if (range === null || !g.success) return invalid(c);
    return c.json(
      await center.overview(c.get("principal"), { ...(range ? { range } : {}), grouping: g.data }),
    );
  });

  app.get(`${base}/report`, async (c) => {
    const range = parseRange(c);
    const filters = parseFilters(c);
    const g = granularity.safeParse(c.req.query("granularity") ?? "day");
    if (range === null || !filters || !g.success) return invalid(c);
    return c.json(
      await center.analytics(c.get("principal"), {
        ...(range ? { range } : {}),
        granularity: g.data,
        filters,
      }),
    );
  });

  app.get(`${base}/users`, async (c) => {
    const range = parseRange(c);
    const filters = parseFilters(c);
    const q = usersQuery.safeParse(c.req.query());
    if (range === null || !filters || !q.success) return invalid(c);
    const { sort, dir, page, page_size: pageSize, q: needle } = q.data;
    return c.json(
      await center.usersByActivity(c.get("principal"), {
        ...(range ? { range } : {}),
        filters,
        ...(sort ? { sort } : {}),
        ...(dir ? { dir } : {}),
        ...(needle ? { q: needle } : {}),
        ...(page ? { page } : {}),
        ...(pageSize ? { pageSize } : {}),
      }),
    );
  });

  // One endpoint for every chart and table: ?chart=power_users, users, outcomes, ...
  app.get(`${base}/csv`, async (c) => {
    const chart = c.req.query("chart") ?? "";
    const range = parseRange(c);
    const filters = parseFilters(c);
    const g = grouping.safeParse(c.req.query("grouping") ?? "day");
    const gran = granularity.safeParse(c.req.query("granularity") ?? "day");
    const u = usersQuery.safeParse(c.req.query());
    if (
      !CSV_CHARTS.has(chart) ||
      range === null ||
      !filters ||
      !g.success ||
      !gran.success ||
      !u.success
    ) {
      return invalid(c);
    }
    const { sort, dir, q: needle } = u.data;
    return csv(
      c,
      await center.csv(c.get("principal"), chart as ReportChart | "users", {
        ...(range ? { range } : {}),
        grouping: g.data,
        granularity: gran.data,
        filters,
        users: {
          ...(sort ? { sort } : {}),
          ...(dir ? { dir } : {}),
          ...(needle ? { q: needle } : {}),
        },
      }),
    );
  });

  app.get(`${base}/outcomes`, async (c) => {
    const range = parseRange(c);
    if (range === null) return invalid(c);
    return c.json(await center.outcomes(c.get("principal"), range ? { range } : {}));
  });

  app.get(`${base}/baselines`, async (c) =>
    c.json({ baselines: await center.baselines(c.get("principal")) }),
  );

  app.put(`${base}/baselines/:type`, small, async (c) => {
    const type = c.req.param("type");
    const body = baselineBody.safeParse(await c.req.json().catch(() => null));
    if (!WORKFLOW_TYPES.includes(type as WorkflowType) || !body.success) return invalid(c);
    return c.json({
      baselines: await center.setBaseline(
        c.get("principal"),
        type as WorkflowType,
        {
          hours: body.data.hours,
          ...(body.data.note === undefined ? {} : { note: body.data.note }),
        },
        clientOf(c),
      ),
    });
  });

  app.post(`${base}/refresh`, async (c) => c.json(await center.refresh(c.get("principal"))));

  app.get(`${base}/actions`, async (c) =>
    c.json({ actions: await center.recommendedActions(c.get("principal")) }),
  );
  app.post(`${base}/actions/:key/dismiss`, async (c) => {
    await center.dismissAction(c.get("principal"), c.req.param("key"));
    return c.body(null, 204);
  });

  app.post(`${base}/exports`, small, async (c) => {
    const body = exportBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const job = await center.createExport(
      c.get("principal"),
      {
        range: { from: body.data.from, to: body.data.to },
        ...(body.data.surfaces ? { surfaces: body.data.surfaces } : {}),
        ...(body.data.include_former === undefined
          ? {}
          : { includeFormer: body.data.include_former }),
      },
      clientOf(c),
    );
    return c.json({ export: job }, 201);
  });

  app.get(`${base}/exports`, async (c) =>
    c.json({ exports: await center.listExports(c.get("principal")) }),
  );

  app.get(`${base}/exports/:id/download`, async (c) => {
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return c.json(
        { code: "NOT_FOUND", message: "That export wasn't found or has expired." },
        404,
      );
    }
    const file = await center.downloadExport(c.get("principal"), id);
    return c.body(file.bytes as Uint8Array<ArrayBuffer>, 200, {
      "content-type": file.gzip ? "application/gzip" : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file.filename}"`,
    });
  });

  return app;
}
