import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import { createLimiter } from "../auth/limiter.js";
import type {
  AskFailure,
  AskResult,
  CitationView,
  MessageView,
  ThreadSummary,
  Threads,
  ThreadView,
} from "./threads.js";

type Env = { Variables: { principal: Principal } };

// Each ask can spend money on a model, so one person can't run up a bill.
const ASKS_PER_WINDOW = 20;
const ASK_WINDOW_MS = 10 * 60_000;
const MAX_DOCUMENTS = 20;

const FAILURES: Record<AskFailure, { status: 400 | 403 | 404 | 503; message: string }> = {
  FORBIDDEN: { status: 403, message: "You don't have permission to ask questions." },
  NOT_FOUND: { status: 404, message: "That thread or document wasn't found." },
  MIXED_MATTERS: { status: 400, message: "Choose documents from a single matter." },
  MODEL_UNAVAILABLE: {
    status: 503,
    message: "No model could answer just now, so nothing was saved. Try again shortly.",
  },
};

const question = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((text) => !text.includes("\0"), "Postgres text cannot hold a NUL byte");

const startBody = z.object({
  question,
  document_ids: z.array(z.uuid()).min(1).max(MAX_DOCUMENTS),
});
const replyBody = z.object({ question });

const citationJson = (citation: CitationView) => ({
  n: citation.n,
  at: citation.at,
  document_id: citation.documentId,
  version_id: citation.versionId,
  document_name: citation.documentName,
  page: citation.page,
  quote: citation.quote,
  char_from: citation.from,
  char_to: citation.to,
  status: citation.status,
});

const messageJson = (message: MessageView) => ({
  id: message.id,
  role: message.role,
  content: message.content,
  model: message.model,
  created_at: message.createdAt,
  citations: message.citations.map(citationJson),
});

const summaryJson = (thread: ThreadSummary) => ({
  id: thread.id,
  title: thread.title,
  matter_id: thread.matterId,
  created_at: thread.createdAt,
});

const threadJson = (thread: ThreadView) => ({
  ...summaryJson(thread),
  documents: thread.documents.map((document) => ({
    id: document.id,
    version_id: document.versionId,
    name: document.name,
    page_count: document.pageCount,
    empty_page_count: document.emptyPageCount,
  })),
  messages: thread.messages.map(messageJson),
});

const invalid = (c: Context) =>
  c.json({ code: "INVALID_REQUEST", message: "Check the question and documents." }, 400);

export function threadRoutes(
  threads: Threads,
  clientOf: (c: Context) => Client,
  now: () => number = Date.now,
) {
  const app = new Hono<Env>();
  const asks = createLimiter({ limit: ASKS_PER_WINDOW, windowMs: ASK_WINDOW_MS, now });
  const limitBody = bodyLimit({ maxSize: 16 * 1024, onError: (c) => invalid(c) });

  const respond = (c: Context<Env>, result: AskResult, created: boolean) => {
    if (!result.ok) {
      const { status, message } = FAILURES[result.reason];
      return c.json({ code: result.reason, message }, status);
    }
    return c.json({ thread: threadJson(result.thread) }, created ? 201 : 200);
  };

  // Checked after the body is valid, so a malformed request doesn't use up an ask.
  const tooMany = (c: Context<Env>) => {
    const wait = asks.take(c.get("principal").userId);
    if (wait === 0) return null;
    c.header("Retry-After", String(wait));
    return c.json(
      { code: "TOO_MANY_REQUESTS", message: "You've asked a lot just now. Try again shortly." },
      429,
    );
  };

  app.post("/", limitBody, async (c) => {
    const parsed = startBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    const limited = tooMany(c);
    if (limited) return limited;
    const result = await threads.start(
      c.get("principal"),
      { question: parsed.data.question, documentIds: parsed.data.document_ids },
      clientOf(c),
    );
    return respond(c, result, true);
  });

  app.get("/", async (c) => {
    const found = await threads.list(c.get("principal"));
    return c.json({ threads: found.map(summaryJson) });
  });

  app.get("/:id", async (c) => {
    const thread = await threads.get(c.get("principal"), c.req.param("id"));
    if (!thread) return c.json({ code: "NOT_FOUND", message: FAILURES.NOT_FOUND.message }, 404);
    return c.json({ thread: threadJson(thread) });
  });

  app.post("/:id/messages", limitBody, async (c) => {
    const parsed = replyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    const limited = tooMany(c);
    if (limited) return limited;
    const result = await threads.reply(
      c.get("principal"),
      c.req.param("id"),
      { question: parsed.data.question },
      clientOf(c),
    );
    return respond(c, result, false);
  });

  return app;
}
