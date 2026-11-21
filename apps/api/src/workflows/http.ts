import { FileRef } from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import { MAX_FILE_BYTES } from "../documents/documents.js";
import type { Result, WorkflowFailure, Workflows } from "./workflows.js";

type Env = { Variables: { principal: Principal } };
type Status = 400 | 403 | 404 | 409 | 413 | 415 | 422;

const FAILURES: Record<WorkflowFailure, { status: Status; message: string }> = {
  NOT_FOUND: { status: 404, message: "That workflow or file wasn't found." },
  FORBIDDEN: { status: 403, message: "You don't have access to do that with this workflow." },
  SCHEMA_INVALID: { status: 400, message: "That isn't a workflow definition." },
  WF_INVALID: { status: 409, message: "Fix the workflow's errors first." },
  NO_DRAFT: { status: 409, message: "There is no draft to publish." },
  NOT_LIVE: { status: 409, message: "This workflow has no published version to run." },
  INPUT_INVALID: { status: 400, message: "Check the form: some inputs aren't right." },
  FILE_IN_USE: { status: 409, message: "Blocks still use that file; remove them first." },
  UNSUPPORTED_TYPE: { status: 415, message: "That file type isn't supported here." },
  FILE_TOO_LARGE: { status: 413, message: "That file is too large." },
};

const UUID = z.uuid();
const Title = z.string().trim().min(1).max(120);
const CreateBody = z.object({ title: Title, definition: z.unknown().optional() });
const DefinitionBody = z.object({ definition: z.unknown() });
const RunBody = z.object({
  inputs: z.record(
    z.string().max(40),
    z.union([
      z.array(FileRef).max(1000),
      z.string().max(20000),
      z.array(z.string().max(60)).max(20),
    ]),
  ),
  thread_id: UUID.optional(),
  matter_id: UUID.optional(),
  space_id: UUID.optional(),
  test_mode: z.boolean().optional(),
});
const fileName = z.string().min(1).max(255);

/** Workflow Builder endpoints (agents-workflows.md §5.2); runs are followed under /runs. */
export function workflowHttp(workflows: Workflows, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();
  const jsonLimit = bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (c) => c.json({ code: "TOO_LARGE", message: "That request is too large." }, 413),
  });
  const fileLimit = bodyLimit({
    maxSize: MAX_FILE_BYTES + 64 * 1024,
    onError: (c) =>
      c.json({ code: "FILE_TOO_LARGE", message: FAILURES.FILE_TOO_LARGE.message }, 413),
  });

  const send = <T>(c: Context, result: Result<T>, status: 200 | 201 = 200) => {
    if (result.ok) return c.json(result.value as object, status);
    const f = FAILURES[result.reason];
    const body: Record<string, unknown> = { code: result.reason, message: f.message };
    if (result.reason === "WF_INVALID") Object.assign(body, result.detail as object);
    else if (result.reason === "FILE_IN_USE") Object.assign(body, result.detail as object);
    else if (result.detail !== undefined) body.issues = result.detail;
    return c.json(body, f.status);
  };
  const invalid = (c: Context) =>
    c.json({ code: "INVALID_REQUEST", message: "Check the request body." }, 400);
  const body = async <S extends z.ZodType>(c: Context, schema: S) => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    return parsed.success ? (parsed.data as z.infer<S>) : null;
  };
  const readFile = async (c: Context<Env>) => {
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    if (!(file instanceof File) || !fileName.safeParse(file.name).success) return null;
    return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
  };

  app.get("/workflows", async (c) => {
    const catalogue = c.req.query("filter[catalogue]");
    const owner = c.req.query("filter[owner]");
    const q = c.req.query("q");
    const found = await workflows.list(c.get("principal"), {
      ...(catalogue === "true" || catalogue === "false" ? { catalogue: catalogue === "true" } : {}),
      ...(owner === "me" || owner === "shared" || owner === "all" ? { owner } : {}),
      ...(q ? { q: q.slice(0, 200) } : {}),
    });
    return c.json({ workflows: found });
  });

  app.post("/workflows", jsonLimit, async (c) => {
    const b = await body(c, CreateBody);
    if (!b) return invalid(c);
    return send(c, await workflows.create(c.get("principal"), b, clientOf(c)), 201);
  });

  app.get("/workflows/:id", async (c) => {
    const found = await workflows.get(c.get("principal"), c.req.param("id"));
    return found ? c.json(found) : send(c, { ok: false, reason: "NOT_FOUND" });
  });

  app.put("/workflows/:id/draft", jsonLimit, async (c) => {
    const b = await body(c, DefinitionBody);
    if (!b) return invalid(c);
    return send(
      c,
      await workflows.saveDraft(c.get("principal"), c.req.param("id"), b.definition, clientOf(c)),
    );
  });

  app.post("/workflows/:id/validate", jsonLimit, async (c) => {
    const b = await body(c, DefinitionBody);
    if (!b) return invalid(c);
    return send(c, await workflows.validate(c.get("principal"), c.req.param("id"), b.definition));
  });

  app.post("/workflows/:id/publish", async (c) =>
    send(c, await workflows.publish(c.get("principal"), c.req.param("id"), clientOf(c))),
  );

  app.get("/workflows/:id/intake-form", async (c) =>
    send(c, await workflows.intakeForm(c.get("principal"), c.req.param("id"))),
  );

  app.post("/workflows/:id/run", jsonLimit, async (c) => {
    const b = await body(c, RunBody);
    if (!b) return invalid(c);
    const { thread_id, matter_id, space_id, test_mode, inputs } = b;
    return send(
      c,
      await workflows.run(
        c.get("principal"),
        c.req.param("id"),
        {
          inputs,
          ...(thread_id ? { thread_id } : {}),
          ...(matter_id ? { matter_id } : {}),
          ...(space_id ? { space_id } : {}),
          ...(test_mode !== undefined ? { test_mode } : {}),
        },
        clientOf(c),
      ),
      201,
    );
  });

  app.get("/workflows/:id/files", async (c) => {
    const result = await workflows.files(c.get("principal"), c.req.param("id"));
    return result.ok ? c.json({ files: result.value }) : send(c, result);
  });

  app.post("/workflows/:id/files", fileLimit, async (c) => {
    const file = await readFile(c);
    if (!file) return invalid(c);
    return send(
      c,
      await workflows.uploadFile(c.get("principal"), c.req.param("id"), file, clientOf(c)),
      201,
    );
  });

  app.put("/workflows/:id/files/:document", fileLimit, async (c) => {
    const file = await readFile(c);
    if (!file) return invalid(c);
    return send(
      c,
      await workflows.replaceFile(
        c.get("principal"),
        c.req.param("id"),
        c.req.param("document"),
        file,
        clientOf(c),
      ),
    );
  });

  app.delete("/workflows/:id/files/:document", async (c) => {
    const result = await workflows.removeFile(
      c.get("principal"),
      c.req.param("id"),
      c.req.param("document"),
      clientOf(c),
    );
    return result.ok ? c.body(null, 204) : send(c, result);
  });

  app.post("/workflows/:id/duplicate", async (c) =>
    send(c, await workflows.duplicate(c.get("principal"), c.req.param("id"), clientOf(c)), 201),
  );

  app.delete("/workflows/:id", async (c) => {
    const result = await workflows.remove(c.get("principal"), c.req.param("id"), clientOf(c));
    return result.ok ? c.body(null, 204) : send(c, result);
  });

  return app;
}
