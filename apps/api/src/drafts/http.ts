import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { DraftFailure, DraftResult, Drafts, DraftView } from "./drafts.js";

type Env = { Variables: { principal: Principal } };

const FAILURES: Record<DraftFailure, { status: 403 | 404 | 409 | 503; message: string }> = {
  NOT_FOUND: { status: 404, message: "That draft or thread wasn't found." },
  FORBIDDEN: { status: 403, message: "You can't change this draft." },
  LIMIT_DRAFTS: { status: 409, message: "A thread can hold 20 drafts. Remove one first." },
  MODEL_UNAVAILABLE: { status: 503, message: "No model could edit just now. Try again shortly." },
};

const noNul = (text: string) => !text.includes("\0");
const createBody = z.object({
  kind: z.enum(["notepad", "editor"]),
  title: z.string().max(200).refine(noNul).optional(),
  from_message_id: z.uuid().optional(),
});
const saveBody = z.object({ body: z.string().max(1_000_000).refine(noNul) });
const editBody = z.object({ instruction: z.string().trim().min(1).max(4000).refine(noNul) });
const versionNo = z.coerce
  .number()
  .int()
  .min(1)
  .max(2 ** 31 - 1);

const draftJson = (draft: DraftView) => ({
  id: draft.id,
  thread_id: draft.threadId,
  kind: draft.kind,
  title: draft.title,
  read_only: !draft.mine,
  versions: draft.versions.map((v) => ({
    no: v.no,
    author: v.author,
    created_at: v.createdAt,
    chars: v.chars,
    changes: v.changes,
  })),
  latest: draft.latest,
});

const invalid = (c: Context) =>
  c.json({ code: "INVALID_REQUEST", message: "Check the draft details." }, 400);
const notFound = (c: Context) =>
  c.json({ code: "NOT_FOUND", message: FAILURES.NOT_FOUND.message }, 404);

export function draftHttp(drafts: Drafts, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();
  const limitBody = bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => invalid(c) });

  const respond = (c: Context<Env>, result: DraftResult, status: 200 | 201 = 200) => {
    if (!result.ok) {
      const failure = FAILURES[result.reason];
      return c.json({ code: result.reason, message: failure.message }, failure.status);
    }
    return c.json({ draft: draftJson(result.draft) }, status);
  };

  app.post("/threads/:id/drafts", limitBody, async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    const { kind, title, from_message_id } = parsed.data;
    const result = await drafts.create(
      c.get("principal"),
      c.req.param("id"),
      {
        kind,
        ...(title ? { title } : {}),
        ...(from_message_id ? { fromMessageId: from_message_id } : {}),
      },
      clientOf(c),
    );
    return respond(c, result, 201);
  });

  app.get("/threads/:id/drafts", async (c) => {
    const found = await drafts.list(c.get("principal"), c.req.param("id"));
    return found ? c.json({ items: found.map(draftJson) }) : notFound(c);
  });

  app.get("/drafts/:id", async (c) => {
    const draft = await drafts.get(c.get("principal"), c.req.param("id"));
    return draft ? c.json({ draft: draftJson(draft) }) : notFound(c);
  });

  app.get("/drafts/:id/versions/:no", async (c) => {
    const no = versionNo.safeParse(c.req.param("no"));
    if (!no.success) return invalid(c);
    const body = await drafts.body(c.get("principal"), c.req.param("id"), no.data);
    return body === null ? notFound(c) : c.json({ no: no.data, body });
  });

  app.post("/drafts/:id/versions", limitBody, async (c) => {
    const parsed = saveBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    return respond(
      c,
      await drafts.save(c.get("principal"), c.req.param("id"), parsed.data.body),
      201,
    );
  });

  app.post("/drafts/:id/edit", limitBody, async (c) => {
    const parsed = editBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    return respond(
      c,
      await drafts.edit(c.get("principal"), c.req.param("id"), parsed.data.instruction),
      201,
    );
  });

  app.post("/drafts/:id/versions/:no/restore", async (c) => {
    const no = versionNo.safeParse(c.req.param("no"));
    if (!no.success) return invalid(c);
    return respond(c, await drafts.restore(c.get("principal"), c.req.param("id"), no.data), 201);
  });

  app.get("/drafts/:id/diff", async (c) => {
    const from = versionNo.safeParse(c.req.query("from"));
    const to = versionNo.safeParse(c.req.query("to"));
    if (!from.success || !to.success) return invalid(c);
    const diff = await drafts.diff(c.get("principal"), c.req.param("id"), from.data, to.data);
    return diff ? c.json({ ops: diff.ops, summary: diff.summary }) : notFound(c);
  });

  app.get("/drafts/:id/export", async (c) => {
    const raw = c.req.query("tracked_from");
    const tracked = raw === undefined ? null : versionNo.safeParse(raw);
    if (tracked && !tracked.success) return invalid(c);
    const file = await drafts.export(
      c.get("principal"),
      c.req.param("id"),
      tracked?.success ? { trackedFrom: tracked.data } : {},
      clientOf(c),
    );
    if (!file) return notFound(c);
    c.header(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    c.header(
      "Content-Disposition",
      `attachment; filename="draft.docx"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    );
    return c.body(file.bytes.slice().buffer as ArrayBuffer);
  });

  return app;
}
