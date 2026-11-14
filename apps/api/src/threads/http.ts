import {
  ContentBlock,
  citationPath,
  FINISHED,
  isTerminal,
  type KnowledgePort,
  ResponseMode,
  ThreadScope,
  type VaultPort,
} from "@legallabs/contracts";
import type { Gateway } from "@legallabs/model-gateway";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import { createLimiter } from "../auth/limiter.js";
import type { RunLog } from "../runs/log.js";
import type {
  AskFailure,
  CitationView,
  HistoryRow,
  MessageView,
  RunView,
  Threads,
  ThreadView,
} from "./threads.js";

type Env = { Variables: { principal: Principal } };

export interface ThreadHttpOptions {
  threads: Threads;
  log: RunLog;
  gateway: Gateway;
  vaults: VaultPort;
  knowledge: KnowledgePort;
  clientOf: (c: Context) => Client;
  now?: () => number;
  /** Each ask can spend money on a model, so one person can't run up a bill. */
  asksPerWindow?: number;
}

const ASK_WINDOW_MS = 10 * 60_000;
// Polled as well as woken, so a run finished by another server process still reaches the reader.
const POLL_MS = 5_000;
const MAX_STREAM_MS = 30 * 60_000;
const MAX_STREAMS = 10;

const FAILURES: Record<AskFailure, { status: 400 | 403 | 404 | 409; message: string }> = {
  FORBIDDEN: { status: 403, message: "You don't have permission to ask questions." },
  NOT_FOUND: { status: 404, message: "That thread or document wasn't found." },
  MIXED_MATTERS: { status: 400, message: "Choose documents from a single matter." },
  EMPTY_SCOPE: { status: 400, message: "Attach a file, a vault or a source to ask about." },
  MODEL_NOT_ALLOWED: { status: 403, message: "That model isn't available to you." },
  READ_ONLY: { status: 409, message: "This thread was shared with you, so it's read-only." },
};

const noNul = (text: string) => !text.includes("\0");
const blocks = z
  .union([z.string(), z.array(ContentBlock).min(1).max(200)])
  .transform((content): ContentBlock[] =>
    typeof content === "string" ? [{ type: "text", text: content }] : content,
  )
  .refine(
    (content) => {
      const text = content.map((b) => (b.type === "text" ? b.text : b.label)).join("");
      const refs = content.every((b) => b.type === "text" || noNul(b.ref_id));
      return refs && text.trim().length > 0 && text.length <= 100_000 && noNul(text);
    },
    { message: "Write a question of up to 100,000 characters." },
  );

const askBody = z.object({
  content: blocks,
  scope: ThreadScope.default({ document_ids: [], vault_ids: [], sources: [] }),
  matter_id: z.uuid().nullable().optional(),
  model: z.string().min(1).max(200).optional(),
  response_mode: ResponseMode.optional(),
  deep_analysis: z.boolean().optional(),
});

const planEditBody = z.object({ instruction: z.string().trim().min(1).max(4000).refine(noNul) });

// The stored plan keeps the file list for approval after a restart; callers see only the plan.
const shownPlan = (plan: unknown) => {
  if (!plan || typeof plan !== "object") return null;
  const { scope: _scope, ...shown } = plan as Record<string, unknown>;
  return shown;
};

const shareBody = z.object({
  user_ids: z.array(z.uuid()).max(50).default([]),
  link: z.boolean().default(false),
});

const historyQuery = z.object({
  q: z.string().max(200).optional(),
  type: z.enum(["assist", "deep_analysis"]).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  docs: z.enum(["0", "1", "2-10", "11-100", ">100"]).optional(),
  favourites: z.enum(["true", "false"]).optional(),
  cursor: z.string().max(100).optional(),
});

const citationJson = (citation: CitationView) => ({
  n: citation.n,
  at: citation.at,
  kind: citation.kind,
  document_id: citation.documentId,
  version_id: citation.versionId,
  version_no: citation.versionNo,
  document_name: citation.documentName,
  page: citation.page,
  quote: citation.quote,
  char_from: citation.from,
  char_to: citation.to,
  status: citation.status,
  authority: citation.authority,
  // Only a verified citation links anywhere.
  open_url:
    citation.status !== "ok"
      ? null
      : citation.authority
        ? /^https:\/\//i.test(citation.authority.url)
          ? citation.authority.url
          : null
        : citation.documentId && citation.versionNo && citation.page
          ? citationPath({
              document_id: citation.documentId,
              version_no: citation.versionNo,
              page: citation.page,
              ...(citation.from !== null && citation.to !== null
                ? { char_from: citation.from, char_to: citation.to }
                : {}),
            })
          : null,
});

const messageJson = (message: MessageView) => ({
  id: message.id,
  role: message.role,
  content: message.content,
  model: message.model,
  requested_model: message.requestedModel,
  fallback: message.fallback,
  input_tokens: message.inputTokens,
  output_tokens: message.outputTokens,
  cost_usd: message.costUsd,
  ungrounded: message.ungrounded,
  created_at: message.createdAt,
  citations: message.citations.map(citationJson),
});

const runJson = (run: RunView) => ({
  id: run.id,
  kind: run.kind,
  status: run.status,
  thread_id: run.threadId,
  question_id: run.questionId,
  message_id: run.answerId,
  coverage: run.coverage,
  plan: shownPlan(run.plan),
  model: run.model,
  cost_usd: run.costUsd,
});

const threadJson = (thread: ThreadView) => ({
  id: thread.id,
  title: thread.title,
  matter_id: thread.matterId,
  created_at: thread.createdAt,
  read_only: !thread.mine,
  vault_ids: thread.vaultIds,
  sources: thread.sources,
  documents: thread.documents.map((document) => ({
    id: document.id,
    version_id: document.versionId,
    version_no: document.versionNo,
    name: document.name,
    page_count: document.pageCount,
    empty_page_count: document.emptyPageCount,
  })),
  messages: thread.messages.map(messageJson),
  runs: thread.runs.map(runJson),
});

const historyJson = (row: HistoryRow) => ({
  id: row.id,
  title: row.title,
  type: row.type,
  matter_id: row.matterId,
  document_count: row.documentCount,
  model: row.model,
  cost_usd: row.costUsd,
  last_activity_at: row.lastActivityAt,
  status: row.status,
  favourite: row.favourite,
  shared: row.shared,
});

const invalid = (c: Context) =>
  c.json({ code: "INVALID_REQUEST", message: "Check the question and what it should read." }, 400);
const notFound = (c: Context) => c.json({ code: "NOT_FOUND", message: "That wasn't found." }, 404);

export function threadHttp(options: ThreadHttpOptions) {
  const { threads, log, clientOf, now = Date.now } = options;
  const asks = createLimiter({
    limit: options.asksPerWindow ?? 20,
    windowMs: ASK_WINDOW_MS,
    now,
  });
  const limitBody = bodyLimit({ maxSize: 512 * 1024, onError: (c) => invalid(c) });
  const app = new Hono<Env>();
  const streams = new Map<string, number>();

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

  const ask = async (c: Context<Env>, threadId?: string) => {
    const parsed = askBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    const limited = tooMany(c);
    if (limited) return limited;
    const body = parsed.data;
    const result = await threads.ask(
      c.get("principal"),
      {
        ...(threadId ? { threadId } : {}),
        blocks: body.content,
        scope: body.scope,
        ...(body.matter_id !== undefined ? { matterId: body.matter_id } : {}),
        ...(body.model ? { model: body.model } : {}),
        ...(body.response_mode ? { responseMode: body.response_mode } : {}),
        ...(body.deep_analysis ? { deepAnalysis: true } : {}),
      },
      clientOf(c),
    );
    if (!result.ok) {
      const { status, message } = FAILURES[result.reason];
      return c.json({ code: result.reason, message }, status);
    }
    return c.json(
      { thread_id: result.threadId, message_id: result.questionId, run_id: result.runId },
      202,
    );
  };

  app.post("/threads", limitBody, (c) => ask(c));
  app.post("/threads/:id/messages", limitBody, (c) => ask(c, c.req.param("id")));

  app.get("/threads/:id", async (c) => {
    const thread = await threads.get(c.get("principal"), c.req.param("id"));
    return thread ? c.json({ thread: threadJson(thread) }) : notFound(c);
  });

  app.get("/history", async (c) => {
    const parsed = historyQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c);
    const { favourites, ...rest } = parsed.data;
    const page = await threads.history(c.get("principal"), {
      ...rest,
      ...(favourites ? { favourites: favourites === "true" } : {}),
    });
    return c.json({ items: page.rows.map(historyJson), next_cursor: page.nextCursor });
  });

  app.put("/threads/:id/favourite", async (c) =>
    (await threads.favourite(c.get("principal"), c.req.param("id"), true))
      ? c.body(null, 204)
      : notFound(c),
  );
  app.delete("/threads/:id/favourite", async (c) =>
    (await threads.favourite(c.get("principal"), c.req.param("id"), false))
      ? c.body(null, 204)
      : notFound(c),
  );

  app.get("/threads/:id/shares", async (c) => {
    const shares = await threads.shares(c.get("principal"), c.req.param("id"));
    if (!shares) return notFound(c);
    return c.json({
      items: shares.map((share) => ({
        id: share.id,
        principal_type: share.principalType,
        principal_id: share.principalId,
        email: share.email,
        granted_at: share.grantedAt,
      })),
    });
  });

  app.post("/threads/:id/shares", limitBody, async (c) => {
    const parsed = shareBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    const result = await threads.share(
      c.get("principal"),
      c.req.param("id"),
      { userIds: parsed.data.user_ids, link: parsed.data.link },
      clientOf(c),
    );
    if (!result.ok) {
      return result.reason === "NOT_FOUND"
        ? notFound(c)
        : c.json(
            {
              code: "WALL_MISMATCH",
              message: "A thread behind an ethical wall can't be shared by link.",
            },
            409,
          );
    }
    return c.json({
      created: result.outcomes.filter((o) => o.outcome === "created").map((o) => o.userId),
      rejected: result.outcomes
        .filter((o) => o.outcome !== "created")
        .map((o) => ({ id: o.userId, reason: o.outcome })),
    });
  });

  app.delete("/threads/:id/shares/:share", async (c) =>
    (await threads.revoke(c.get("principal"), c.req.param("id"), c.req.param("share"), clientOf(c)))
      ? c.body(null, 204)
      : notFound(c),
  );

  app.post("/threads/:id/duplicate", async (c) => {
    const copy = await threads.duplicate(c.get("principal"), c.req.param("id"), clientOf(c));
    return copy ? c.json({ thread_id: copy }, 201) : notFound(c);
  });

  app.get("/members", async (c) => {
    const members = await threads.members(c.get("principal"), c.req.query("q") ?? "");
    return c.json({ items: members });
  });

  // Everything the composer offers, in one round trip.
  app.get("/scope-options", async (c) => {
    const principal = c.get("principal");
    const [vaults, sources] = await Promise.all([
      options.vaults.list(principal),
      options.knowledge.list(principal),
    ]);
    const models = options.gateway.models("synthesize");
    return c.json({ vaults, sources, models });
  });

  app.get("/runs/:id", async (c) => {
    const run = await threads.run(c.get("principal"), c.req.param("id"));
    return run ? c.json({ run: runJson(run) }) : notFound(c);
  });

  app.post("/runs/:id/approve", async (c) =>
    (await threads.approve(c.get("principal"), c.req.param("id"), clientOf(c)))
      ? c.body(null, 202)
      : c.json(
          { code: "NOT_AWAITING_APPROVAL", message: "That plan isn't waiting for approval." },
          409,
        ),
  );

  app.post("/runs/:id/plan/edit", limitBody, async (c) => {
    const parsed = planEditBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    return (await threads.editPlan(c.get("principal"), c.req.param("id"), parsed.data.instruction))
      ? c.body(null, 202)
      : c.json(
          { code: "NOT_AWAITING_APPROVAL", message: "That plan isn't waiting for approval." },
          409,
        );
  });

  app.post("/runs/:id/cancel", async (c) =>
    (await threads.cancel(c.get("principal"), c.req.param("id"), clientOf(c)))
      ? c.body(null, 202)
      : notFound(c),
  );

  // Replays what was missed, then follows live; Last-Event-ID resumes after a drop.
  app.get("/runs/:id/events", async (c) => {
    const principal = c.get("principal");
    const runId = c.req.param("id");
    const run = await threads.run(principal, runId);
    if (!run) return notFound(c);
    const open = streams.get(principal.userId) ?? 0;
    if (open >= MAX_STREAMS) {
      return c.json({ code: "TOO_MANY_STREAMS", message: "Close another tab first." }, 429);
    }
    streams.set(principal.userId, open + 1);
    const after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0);
    const start = Number.isInteger(after) && after >= 0 ? after : 0;
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let wake: (() => void) | null = null;
      // Live events only wake the loop; the log is always read back, so order and gaps are safe.
      const stop = log.subscribe(runId, () => wake?.());
      stream.onAbort(() => wake?.());
      const opened = now();
      let last = start;
      try {
        while (!stream.aborted && now() - opened < MAX_STREAM_MS) {
          // Read back as the caller each time, so a new wall or a revoked share ends the stream.
          const batch = await log.replay(principal, runId, last);
          for (const event of batch) {
            last = event.seq;
            const { type, ...data } = event;
            await stream.writeSSE({
              id: String(event.seq),
              event: type,
              data: JSON.stringify(data),
            });
            if (isTerminal(event)) return;
          }
          if (batch.length > 0) continue;
          const current = await threads.run(principal, runId);
          if (!current || FINISHED.includes(current.status)) return;
          let timer: ReturnType<typeof setTimeout> | undefined;
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, POLL_MS);
          });
          clearTimeout(timer);
          wake = null;
          await stream.write(": keep-alive\n\n");
        }
      } finally {
        stop();
        const left = (streams.get(principal.userId) ?? 1) - 1;
        if (left > 0) streams.set(principal.userId, left);
        else streams.delete(principal.userId);
      }
    });
  });

  return app;
}
