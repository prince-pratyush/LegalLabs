import {
  IntakeAssign,
  IntakeChannel,
  IntakeRequestCreate,
  IntakeSetType,
  IntakeStatus,
  IntakeStatusChange,
  IntakeTypeCreate,
  IntakeTypePatch,
} from "@legallabs/contracts";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import { MAX_FILE_BYTES } from "../documents/documents.js";
import type { Intake, IntakeFailure, Result } from "./intake.js";

type Env = { Variables: { principal: Principal } };
type Status = 400 | 403 | 404 | 409 | 413 | 415 | 422;

const FAILURES: Record<IntakeFailure, { status: Status; message: string }> = {
  NOT_FOUND: { status: 404, message: "That request or request type wasn't found." },
  FORBIDDEN: { status: 403, message: "You don't have access to do that." },
  TYPE_NOT_FOUND: { status: 422, message: "That request type wasn't found." },
  INVALID_FIELDS: { status: 422, message: "Some fields don't fit this request type." },
  MATTER_NOT_FOUND: { status: 422, message: "That matter wasn't found." },
  ATTACHMENT_NOT_FOUND: { status: 422, message: "Add the file again, then attach it." },
  ASSIGNEE_NOT_ALLOWED: { status: 422, message: "That person can't take this request." },
  ROUTE_NOT_ACCESSIBLE: { status: 422, message: "Pick a routing target you can open." },
  UNKNOWN_PRINCIPAL: { status: 422, message: "Pick people and groups in this workspace." },
  NAME_TAKEN: { status: 409, message: "There is already a request type with that name." },
  DUPLICATE: { status: 409, message: "That request was already received." },
  TYPE_REQUIRED: { status: 409, message: "Give the request a type first." },
  WRONG_STATE: { status: 409, message: "That request isn't in a state that allows this." },
  BAD_CURSOR: { status: 400, message: "Check the request." },
  UNSUPPORTED_TYPE: { status: 415, message: "That kind of file can't be read." },
  FILE_TOO_LARGE: { status: 413, message: "The file is too large." },
  VAULT_FILE_LIMIT: { status: 422, message: "The intake inbox is full." },
  VAULT_SIZE_LIMIT: { status: 422, message: "The intake inbox is full." },
};

const Filter = z.object({
  status: z.union([IntakeStatus, z.literal("open")]).optional(),
  assigneeId: z.union([z.literal("me"), z.uuid()]).optional(),
  typeId: z.uuid().optional(),
  channel: IntakeChannel.optional(),
  sort: z.enum(["created_at", "-created_at"]).optional(),
  cursor: z.string().max(20).optional(),
});

// Each upload holds the whole file in memory while it is stored.
const MAX_CONCURRENT_UPLOADS = 4;

export function intakeHttp(intake: Intake, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();
  const limitBody = bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => c.json({ code: "TOO_LARGE", message: "That request is too large." }, 413),
  });
  const limitFile = bodyLimit({
    maxSize: MAX_FILE_BYTES + 64 * 1024,
    onError: (c) => c.json({ code: "FILE_TOO_LARGE", message: "The file is too large." }, 413),
  });
  let uploading = 0;
  const limitUploads: MiddlewareHandler = async (c, next) => {
    if (uploading >= MAX_CONCURRENT_UPLOADS) {
      c.header("Retry-After", "2");
      return c.json({ code: "BUSY", message: "Too many uploads are in progress." }, 503);
    }
    uploading++;
    try {
      await next();
    } finally {
      uploading--;
    }
  };

  const invalid = (c: Context, error?: z.ZodError) =>
    c.json(
      {
        code: "INVALID_REQUEST",
        message: "Check the request.",
        details: error?.issues.slice(0, 20).map((i) => ({ path: i.path, code: i.code })) ?? [],
      },
      400,
    );
  async function parse<T extends z.ZodType>(c: Context, schema: T) {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    return parsed.success
      ? { data: parsed.data as z.output<T> }
      : { response: invalid(c, parsed.error) };
  }
  const reply = <T>(
    c: Context,
    result: Result<T>,
    body: (value: T) => object,
    status: 200 | 201 = 200,
  ) => {
    if (result.ok) return c.json(body(result.value), status);
    const f = FAILURES[result.reason];
    return c.json(
      {
        code: result.reason,
        message: f.message,
        ...(result.details && { details: result.details }),
      },
      f.status,
    );
  };
  const one = <T>(request: T) => ({ request });
  const me = (c: Context<Env>) => c.get("principal");
  const id = (c: Context<Env>) => c.req.param("id") ?? "";

  app.get("/apps/intake/request-types", async (c) =>
    reply(c, await intake.listTypes(me(c)), (v) => v),
  );

  app.post("/apps/intake/request-types", limitBody, async (c) => {
    const body = await parse(c, IntakeTypeCreate);
    if (!("data" in body)) return body.response;
    const result = await intake.createType(me(c), body.data, clientOf(c));
    return reply(c, result, (type) => ({ type }), 201);
  });

  app.patch("/apps/intake/request-types/:id", limitBody, async (c) => {
    const body = await parse(c, IntakeTypePatch);
    if (!("data" in body)) return body.response;
    const result = await intake.patchType(me(c), id(c), body.data, clientOf(c));
    return reply(c, result, (type) => ({ type }));
  });

  app.delete("/apps/intake/request-types/:id", async (c) => {
    const result = await intake.deleteType(me(c), id(c), clientOf(c));
    return result.ok ? c.body(null, 204) : reply(c, result, () => ({}));
  });

  app.post("/apps/intake/attachments", limitUploads, limitFile, async (c) => {
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    if (!(file instanceof File) || file.name.length < 1 || file.name.length > 255) {
      return invalid(c);
    }
    const result = await intake.upload(
      me(c),
      { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
      clientOf(c),
    );
    return reply(c, result, (attachment) => ({ attachment }), 201);
  });

  app.get("/apps/intake/requests", async (c) => {
    const query = Filter.safeParse({
      status: c.req.query("filter[status]") || undefined,
      assigneeId: c.req.query("filter[assignee_id]") || undefined,
      typeId: c.req.query("filter[type_id]") || undefined,
      channel: c.req.query("filter[channel]") || undefined,
      sort: c.req.query("sort") || undefined,
      cursor: c.req.query("cursor") || undefined,
    });
    if (!query.success) return invalid(c, query.error);
    const { assigneeId, sort, ...filter } = query.data;
    const result = await intake.list(me(c), {
      ...filter,
      assigneeId: assigneeId === "me" ? me(c).userId : assigneeId,
      oldestFirst: sort === "created_at",
    });
    return reply(c, result, (v) => v);
  });

  app.post("/apps/intake/requests", limitBody, async (c) => {
    const body = await parse(c, IntakeRequestCreate);
    if (!("data" in body)) return body.response;
    return reply(c, await intake.create(me(c), body.data, clientOf(c)), one, 201);
  });

  app.get("/apps/intake/requests/:id", async (c) => reply(c, await intake.get(me(c), id(c)), one));

  app.get("/apps/intake/requests/:id/audit", async (c) =>
    reply(c, await intake.events(me(c), id(c)), (events) => ({ events })),
  );

  app.get("/apps/intake/requests/:id/assignees", async (c) =>
    reply(c, await intake.assignees(me(c), id(c)), (people) => ({ people })),
  );

  app.post("/apps/intake/requests/:id/assign", limitBody, async (c) => {
    const body = await parse(c, IntakeAssign);
    if (!("data" in body)) return body.response;
    return reply(c, await intake.assign(me(c), id(c), body.data.assignee_id, clientOf(c)), one);
  });

  app.post("/apps/intake/requests/:id/type", limitBody, async (c) => {
    const body = await parse(c, IntakeSetType);
    if (!("data" in body)) return body.response;
    return reply(c, await intake.setType(me(c), id(c), body.data.type_id, clientOf(c)), one);
  });

  app.post("/apps/intake/requests/:id/status", limitBody, async (c) => {
    const body = await parse(c, IntakeStatusChange);
    if (!("data" in body)) return body.response;
    return reply(c, await intake.setStatus(me(c), id(c), body.data, clientOf(c)), one);
  });

  return app;
}
