import {
  ApplyAllRequest,
  ApplyRequest,
  DismissRequest,
  ExportRequest,
  RedlineRequest,
  ReviewRequest,
  ReviseRequest,
} from "@legallabs/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { Limiter } from "../auth/limiter.js";
import type { FileOut, ReviewFailure, Reviews } from "./reviews.js";

type Env = { Variables: { principal: Principal } };
type Status = 403 | 404 | 409 | 422 | 503;

const FAILURES: Record<ReviewFailure, { status: Status; message: string }> = {
  NOT_FOUND: { status: 404, message: "That review, playbook or document wasn't found." },
  FORBIDDEN: { status: 403, message: "You don't have access to do that with this review." },
  NOT_PUBLISHED: { status: 422, message: "Publish the playbook before reviewing against it." },
  DOC_TOO_LARGE: {
    status: 422,
    message: "That document is over 1,000,000 characters. Ask about a selection instead.",
  },
  UNSUPPORTED_TYPE: { status: 422, message: "Reviews read Word files and PDFs only." },
  NOT_READY: { status: 409, message: "That document is still being processed. Try again shortly." },
  UNREADABLE: { status: 422, message: "That Word file couldn't be read." },
  REDLINE_NEEDS_DOCX: { status: 422, message: "Redlines need the Word file." },
  DECIDED: { status: 409, message: "That suggestion was already dismissed or replaced." },
  NOT_FINISHED: { status: 409, message: "The review hasn't finished yet." },
  RULE_NOT_FOUND: { status: 404, message: "That rule isn't part of this review." },
  ALTERNATE_NOT_FOUND: { status: 404, message: "That alternate wasn't found." },
  MODEL_UNAVAILABLE: { status: 503, message: "No model could answer. Try again shortly." },
  OOXML_INVALID: { status: 422, message: "The redline couldn't be written into that file." },
};

const RerunRequest = z.object({ document_version_id: z.string().uuid() }).strict();

const contentDisposition = (name: string) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

export function reviewHttp(reviews: Reviews, clientOf: (c: Context) => Client, asks?: Limiter) {
  const app = new Hono<Env>();
  const limitBody = bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => c.json({ code: "TOO_LARGE", message: "That request is too large." }, 413),
  });

  const fail = (c: Context, reason: ReviewFailure) => {
    const f = FAILURES[reason];
    return c.json({ code: reason, message: f.message }, f.status);
  };

  async function parse<T extends z.ZodType>(c: Context, schema: T, empty?: unknown) {
    const raw = await c.req.json().catch(() => empty ?? null);
    const parsed = schema.safeParse(raw);
    if (parsed.success) return { data: parsed.data as z.output<T> };
    return {
      response: c.json(
        {
          code: "INVALID_REQUEST",
          message: "Check the request.",
          details: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path, code: i.code })),
        },
        400,
      ),
    };
  }

  // Each of these spends model calls, from the same budget as thread questions.
  const throttled = (c: Context) => {
    const wait = asks?.take(c.get("principal").userId) ?? 0;
    if (wait <= 0) return null;
    c.header("Retry-After", String(wait));
    return c.json(
      { code: "TOO_MANY_REQUESTS", message: "You've asked a lot just now. Try again shortly." },
      429,
    );
  };

  const file = (c: Context, out: FileOut) =>
    c.body(out.bytes as Uint8Array<ArrayBuffer>, 200, {
      "content-type": out.mime,
      "content-disposition": contentDisposition(out.name),
    });

  app.post("/playbooks/:id/reviews", limitBody, async (c) => {
    const body = await parse(c, ReviewRequest);
    if (!("data" in body)) return body.response;
    const limited = throttled(c);
    if (limited) return limited;
    const result = await reviews.start(
      c.get("principal"),
      c.req.param("id"),
      body.data,
      { draft: c.req.query("version") === "draft" },
      clientOf(c),
    );
    return result.ok ? c.json(result.value, 201) : fail(c, result.reason);
  });

  app.get("/reviews", async (c) => {
    const found = await reviews.list(c.get("principal"), {
      document_id: c.req.query("filter[document_id]") || undefined,
      playbook_id: c.req.query("filter[playbook_id]") || undefined,
    });
    return c.json({ reviews: found });
  });

  app.get("/reviews/:id", async (c) => {
    const review = await reviews.get(c.get("principal"), c.req.param("id"));
    return review ? c.json({ review }) : fail(c, "NOT_FOUND");
  });

  app.get("/reviews/:id/document", async (c) => {
    const result = await reviews.document(c.get("principal"), c.req.param("id"));
    return result.ok ? c.json(result.value) : fail(c, result.reason);
  });

  app.post("/reviews/:id/cancel", async (c) =>
    (await reviews.cancel(c.get("principal"), c.req.param("id"), clientOf(c)))
      ? c.body(null, 202)
      : fail(c, "NOT_FOUND"),
  );

  app.post("/reviews/:id/suggestions/apply-all", limitBody, async (c) => {
    const body = await parse(c, ApplyAllRequest);
    if (!("data" in body)) return body.response;
    const result = await reviews.applyAll(
      c.get("principal"),
      c.req.param("id"),
      body.data,
      clientOf(c),
    );
    return result.ok ? c.json(result.value) : fail(c, result.reason);
  });

  app.post("/reviews/:id/suggestions/:sid/apply", limitBody, async (c) => {
    const body = await parse(c, ApplyRequest);
    if (!("data" in body)) return body.response;
    const result = await reviews.apply(
      c.get("principal"),
      c.req.param("id"),
      c.req.param("sid"),
      body.data,
      clientOf(c),
    );
    return result.ok ? c.json(result.value) : fail(c, result.reason);
  });

  app.post("/reviews/:id/suggestions/:sid/dismiss", limitBody, async (c) => {
    const body = await parse(c, DismissRequest, {});
    if (!("data" in body)) return body.response;
    const result = await reviews.dismiss(
      c.get("principal"),
      c.req.param("id"),
      c.req.param("sid"),
      clientOf(c),
    );
    return result.ok ? c.json({ suggestion: result.value }) : fail(c, result.reason);
  });

  app.post("/reviews/:id/suggestions/:sid/alternates", async (c) => {
    const limited = throttled(c);
    if (limited) return limited;
    const result = await reviews.alternates(
      c.get("principal"),
      c.req.param("id"),
      c.req.param("sid"),
      clientOf(c),
    );
    return result.ok ? c.json({ alternates: result.value }) : fail(c, result.reason);
  });

  app.post("/reviews/:id/suggestions/:sid/revise", limitBody, async (c) => {
    const body = await parse(c, ReviseRequest);
    if (!("data" in body)) return body.response;
    const limited = throttled(c);
    if (limited) return limited;
    const result = await reviews.revise(
      c.get("principal"),
      c.req.param("id"),
      c.req.param("sid"),
      body.data.instruction,
      clientOf(c),
    );
    return result.ok ? c.json({ suggestion: result.value }) : fail(c, result.reason);
  });

  app.post("/reviews/:id/rules/:rule_id/rerun", limitBody, async (c) => {
    const body = await parse(c, RerunRequest);
    if (!("data" in body)) return body.response;
    const limited = throttled(c);
    if (limited) return limited;
    const result = await reviews.rerun(
      c.get("principal"),
      c.req.param("id"),
      c.req.param("rule_id"),
      body.data.document_version_id,
      clientOf(c),
    );
    return result.ok ? c.json(result.value, 202) : fail(c, result.reason);
  });

  // Streamed back as a download rather than stored: a document holds one version today.
  app.post("/reviews/:id/redline", limitBody, async (c) => {
    const body = await parse(c, RedlineRequest, {});
    if (!("data" in body)) return body.response;
    const result = await reviews.redline(
      c.get("principal"),
      c.req.param("id"),
      body.data.include_pending,
      clientOf(c),
    );
    if (!result.ok) return fail(c, result.reason);
    c.header("x-redline-failed", String(result.value.failed));
    return file(c, result.value);
  });

  app.post("/reviews/:id/export", limitBody, async (c) => {
    const body = await parse(c, ExportRequest);
    if (!("data" in body)) return body.response;
    const result = await reviews.exportSummary(
      c.get("principal"),
      c.req.param("id"),
      body.data.format,
      clientOf(c),
    );
    return result.ok ? file(c, result.value) : fail(c, result.reason);
  });

  return app;
}
