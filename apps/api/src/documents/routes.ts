import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import {
  type Documents,
  MAX_FILE_BYTES,
  MAX_PASSAGES,
  type Passage,
  type Summary,
  type UploadResult,
} from "./documents.js";

// A multipart body is a little larger than the file inside it.
const MAX_BODY_BYTES = MAX_FILE_BYTES + 64 * 1024;
// Each upload holds its file in memory and parses it in a worker.
const MAX_CONCURRENT_UPLOADS = 2;

type Env = { Variables: { principal: Principal } };

const failure = (c: Context, status: 400 | 413 | 503, code: string, message: string) =>
  c.json({ code, message }, status);

type Reason = Extract<UploadResult, { ok: false }>["reason"];

const REASONS: Record<Reason, { status: 403 | 404 | 413 | 415; message: string }> = {
  FORBIDDEN: { status: 403, message: "You don't have permission to upload documents." },
  MATTER_NOT_FOUND: { status: 404, message: "That matter wasn't found." },
  FILE_TOO_LARGE: { status: 413, message: "The file is too large." },
  UNSUPPORTED_TYPE: { status: 415, message: "Only PDF, TXT and Markdown files can be read." },
};

const uuid = z.uuid();

const searchQuery = z.object({
  q: z
    .string()
    .min(1)
    .max(500)
    .refine((text) => !text.includes("\0")),
  limit: z.coerce.number().int().min(1).max(MAX_PASSAGES).optional(),
  document_ids: z.array(uuid).max(100).optional(),
});

// Control characters have no place in a name that gets shown in lists and logs.
const fileName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u);

const summaryJson = (document: Summary) => ({
  id: document.id,
  version_id: document.versionId,
  name: document.name,
  mime: document.mime,
  size: document.size,
  status: document.status,
  failure_reason: document.failureReason,
  page_count: document.pageCount,
  empty_page_count: document.emptyPageCount,
  matter_id: document.matterId,
  created_at: document.createdAt,
});

const passageJson = (passage: Passage) => ({
  chunk_id: passage.chunkId,
  document_id: passage.documentId,
  document_version_id: passage.documentVersionId,
  document_name: passage.documentName,
  page: passage.page,
  char_from: passage.from,
  char_to: passage.to,
  text: passage.text,
});

export function documentRoutes(documents: Documents, clientOf: (c: Context) => Client) {
  const app = new Hono<Env>();
  let uploading = 0;

  // Runs before the body is read, so waiting uploads can't pile up in memory.
  const limitUploads: MiddlewareHandler = async (c, next) => {
    if (uploading >= MAX_CONCURRENT_UPLOADS) {
      c.header("Retry-After", "5");
      return failure(c, 503, "BUSY", "Too many uploads are in progress. Try again shortly.");
    }
    uploading++;
    try {
      await next();
    } finally {
      uploading--;
    }
  };

  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => failure(c, 413, "FILE_TOO_LARGE", "The file is too large."),
  });

  app.post("/", limitUploads, limitBody, async (c) => {
    const invalid = () => failure(c, 400, "INVALID_REQUEST", "Send one file in a form field.");
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    if (!(file instanceof File) || !fileName.safeParse(file.name).success) return invalid();
    const matter = form?.matter_id;
    if (matter !== undefined && !uuid.safeParse(matter).success) return invalid();

    const result = await documents.upload(
      c.get("principal"),
      {
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        matterId: typeof matter === "string" ? matter : null,
      },
      clientOf(c),
    );
    if (!result.ok) {
      const { status, message } = REASONS[result.reason];
      return c.json({ code: result.reason, message }, status);
    }
    return c.json({ document: summaryJson(result.document) }, 202);
  });

  app.get("/", async (c) => {
    const found = await documents.list(c.get("principal"));
    return c.json({ documents: found.map(summaryJson) });
  });

  app.get("/search", async (c) => {
    const ids = c.req.queries("document_id");
    const parsed = searchQuery.safeParse({
      q: c.req.query("q"),
      limit: c.req.query("limit"),
      ...(ids ? { document_ids: ids } : {}),
    });
    if (!parsed.success) return failure(c, 400, "INVALID_REQUEST", "Check the search terms.");
    const { q, limit, document_ids } = parsed.data;
    const passages = await documents.search(c.get("principal"), q, {
      ...(limit === undefined ? {} : { limit }),
      ...(document_ids ? { documentIds: document_ids } : {}),
    });
    return c.json({ passages: passages.map(passageJson) });
  });

  // After /search, so "search" is never taken for an id.
  app.get("/:id", async (c) => {
    const found = await documents.get(c.get("principal"), c.req.param("id"));
    if (!found) return c.json({ code: "NOT_FOUND", message: "That document wasn't found." }, 404);
    return c.json({ document: summaryJson(found) });
  });

  app.post("/:id/retry", async (c) => {
    const principal = c.get("principal");
    const id = c.req.param("id");
    if (!(await documents.retry(principal, id, clientOf(c)))) {
      return c.json({ code: "NOT_FOUND", message: "No failed document with that id." }, 404);
    }
    const found = await documents.get(principal, id);
    return c.json({ document: found ? summaryJson(found) : null }, 202);
  });

  return app;
}
