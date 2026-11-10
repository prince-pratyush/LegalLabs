import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import type { Documents, Passage, Summary, UploadResult } from "./documents.js";

// A multipart body is a little larger than the file inside it.
const MAX_BODY_BYTES = 25 * 1024 * 1024 + 64 * 1024;
// Each upload holds its file in memory and parses it in a worker.
const MAX_CONCURRENT_UPLOADS = 2;

type Env = { Variables: { principal: Principal } };

const failure = (c: Context, status: 400 | 413 | 503, code: string, message: string) =>
  c.json({ code, message }, status);

type Reason = Extract<UploadResult, { ok: false }>["reason"];

const REASONS: Record<Reason, { status: 403 | 404 | 413 | 415 | 422 | 500; message: string }> = {
  FORBIDDEN: { status: 403, message: "You don't have permission to upload documents." },
  MATTER_NOT_FOUND: { status: 404, message: "That matter wasn't found." },
  FILE_TOO_LARGE: { status: 413, message: "The file is too large." },
  UNSUPPORTED_TYPE: { status: 415, message: "Only PDF, TXT and Markdown files can be read." },
  CORRUPT_FILE: { status: 422, message: "The file is damaged and can't be read." },
  ENCRYPTED_NO_PASSWORD: { status: 422, message: "The file is password protected." },
  PAGE_LIMIT_EXCEEDED: { status: 422, message: "The document is too long." },
  NO_TEXT: { status: 422, message: "No text was found. Scanned documents can't be read yet." },
  PARSE_TIMEOUT: { status: 422, message: "The file took too long to read." },
  INTERNAL: { status: 500, message: "The file couldn't be processed." },
};

const uuid = z.uuid();

const searchQuery = z.object({
  q: z
    .string()
    .min(1)
    .max(500)
    .refine((text) => !text.includes("\0")),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  document_ids: z.array(uuid).max(100).optional(),
});

// Control characters have no place in a name that gets shown in lists and logs.
const fileName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^\P{Cc}+$/u);

const summaryJson = (document: Summary) => ({
  id: document.id,
  version_id: document.versionId,
  name: document.name,
  mime: document.mime,
  size: document.size,
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
  const oneAtATime: MiddlewareHandler = async (c, next) => {
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

  app.post("/", oneAtATime, limitBody, async (c) => {
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
    return c.json({ document: summaryJson(result.document) }, 201);
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

  return app;
}
