import type { CitationStatus, Range } from "@legallabs/citations";
import type {
  ContentBlock,
  Coverage,
  KnowledgePort,
  ResponseMode,
  RunStatus,
  SourceSelection,
  ThreadScope,
  VaultPort,
} from "@legallabs/contracts";
import type { Gateway } from "@legallabs/model-gateway";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp } from "../db.js";
import type { Documents } from "../documents/documents.js";
import type { NewEvent, RunLog } from "../runs/log.js";
import { type Answer, type Checked, createAnswerer, type ScopeDocument } from "./answer.js";
import { coverageNote, planDeep, REPORT_SHAPE, readDeep, type StoredPlan } from "./deep.js";

export { NOT_FOUND_ANSWER } from "./answer.js";

export interface ThreadDocument extends ScopeDocument {
  emptyPageCount: number;
}

export interface CitationView {
  /** The number shown to the reader, from 1. */
  n: number;
  /** Where the citation sits in the message text. */
  at: number;
  kind: "document" | "authority";
  documentId: string | null;
  versionId: string | null;
  versionNo: number | null;
  documentName: string | null;
  page: number | null;
  quote: string | null;
  /** Where the quote was found on the page, for ok citations only. */
  from: number | null;
  to: number | null;
  status: CitationStatus;
  authority: { id: string; citation: string; title: string; url: string } | null;
}

export interface MessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  requestedModel: string | null;
  fallback: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  ungrounded: Range[];
  createdAt: string;
  citations: CitationView[];
}

export interface RunView {
  id: string;
  kind: "thread" | "deep_analysis";
  status: RunStatus;
  threadId: string;
  questionId: string;
  answerId: string | null;
  coverage: Coverage | null;
  plan: unknown;
  model: string | null;
  costUsd: number;
}

export interface ThreadSummary {
  id: string;
  title: string;
  matterId: string | null;
  createdAt: string;
}

export interface ThreadView extends ThreadSummary {
  /** False for a thread shared with the caller, which they can read but not add to. */
  mine: boolean;
  vaultIds: string[];
  sources: SourceSelection[];
  documents: ThreadDocument[];
  messages: MessageView[];
  runs: RunView[];
}

export interface HistoryFilters {
  q?: string | undefined;
  type?: "assist" | "deep_analysis" | undefined;
  from?: string | undefined;
  to?: string | undefined;
  docs?: "0" | "1" | "2-10" | "11-100" | ">100" | undefined;
  favourites?: boolean | undefined;
  cursor?: string | undefined;
}

export interface HistoryRow {
  id: string;
  title: string;
  type: "assist" | "deep_analysis";
  matterId: string | null;
  documentCount: number;
  model: string | null;
  costUsd: number;
  lastActivityAt: string;
  status: "done" | "running" | "needs_input" | "failed";
  favourite: boolean;
  shared: boolean;
}

export interface AskInput {
  /** Omitted for a new thread. */
  threadId?: string;
  blocks: ContentBlock[];
  scope: ThreadScope;
  matterId?: string | null;
  model?: string;
  responseMode?: ResponseMode;
  /** Plans a read of the whole scope and waits for approval before spending. */
  deepAnalysis?: boolean;
}

export type AskFailure =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "MIXED_MATTERS"
  | "EMPTY_SCOPE"
  | "MODEL_NOT_ALLOWED"
  | "READ_ONLY";

export type AskResult =
  | {
      ok: true;
      threadId: string;
      questionId: string;
      runId: string;
      /** Settles when the run has finished, failed or been cancelled. */
      finished: Promise<void>;
    }
  | { ok: false; reason: AskFailure };

export type ShareOutcome = { userId: string; outcome: "created" | "WALL_DENIED" | "NOT_MEMBER" };
export type ShareResult =
  | { ok: true; outcomes: ShareOutcome[] }
  | { ok: false; reason: "NOT_FOUND" | "WALL_MISMATCH" };

export interface Share {
  id: string;
  principalType: "user" | "workspace";
  principalId: string;
  email: string | null;
  grantedAt: string;
}

export interface Member {
  id: string;
  email: string;
  name: string;
}

export interface Threads {
  ask(principal: Principal, input: AskInput, client: Client): Promise<AskResult>;
  /** Null for anything the caller can't read. */
  get(principal: Principal, threadId: string): Promise<ThreadView | null>;
  history(
    principal: Principal,
    filters: HistoryFilters,
  ): Promise<{ rows: HistoryRow[]; nextCursor: string | null }>;
  run(principal: Principal, runId: string): Promise<RunView | null>;
  cancel(principal: Principal, runId: string, client: Client): Promise<boolean>;
  /** Starts a planned deep analysis. False unless it is the caller's and awaiting approval. */
  approve(principal: Principal, runId: string, client: Client): Promise<boolean>;
  /** Re-plans with a plain-language change; the run stays awaiting approval. */
  editPlan(
    principal: Principal,
    runId: string,
    instruction: string,
    client: Client,
  ): Promise<boolean>;
  favourite(principal: Principal, threadId: string, on: boolean): Promise<boolean>;
  share(
    principal: Principal,
    threadId: string,
    input: { userIds: string[]; link: boolean },
    client: Client,
  ): Promise<ShareResult>;
  shares(principal: Principal, threadId: string): Promise<Share[] | null>;
  revoke(principal: Principal, threadId: string, shareId: string, client: Client): Promise<boolean>;
  duplicate(principal: Principal, threadId: string, client: Client): Promise<string | null>;
  members(principal: Principal, query: string): Promise<Member[]>;
  /** Waits for every run this process started; for tests and shutdown. */
  settled(): Promise<void>;
}

export interface ThreadsOptions {
  gateway: Gateway;
  documents: Documents;
  log: RunLog;
  vaults: VaultPort;
  knowledge: KnowledgePort;
}

const HISTORY_MESSAGES = 6;
const HISTORY_CHARS = 4000;
const MAX_TITLE = 200;
const PAGE = 50;
const VAULT_DOCUMENTS = 10_000;
const MEMBERS = 10;
const RLS_REFUSED = "42501";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Db = pg.PoolClient;

interface DocumentRow {
  id: string;
  version_id: string;
  version_no: number;
  name: string;
  matter_id: string | null;
  page_count: number;
  empty_page_count: number;
}

const DOCUMENT_COLUMNS =
  "d.id, v.id version_id, v.version_no, d.name, d.matter_id, v.page_count, v.empty_page_count";

const toDocument = (row: DocumentRow): ThreadDocument => ({
  id: row.id,
  versionId: row.version_id,
  versionNo: row.version_no,
  name: row.name,
  pageCount: row.page_count,
  emptyPageCount: row.empty_page_count,
});

/** The question as plain text, with each mention as its @label. */
export const questionText = (blocks: readonly ContentBlock[]) =>
  blocks
    .map((block) => (block.type === "text" ? block.text : `@${block.label}`))
    .join("")
    .trim();

const titleOf = (question: string) =>
  [...question.replace(/\s+/g, " ").trim()].slice(0, MAX_TITLE).join("") || "Untitled";

const isRefusal = (err: unknown) => (err as { code?: string }).code === RLS_REFUSED;

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const DOC_BUCKETS: Record<NonNullable<HistoryFilters["docs"]>, [number, number]> = {
  "0": [0, 0],
  "1": [1, 1],
  "2-10": [2, 10],
  "11-100": [11, 100],
  ">100": [101, 2 ** 31 - 1],
};

async function permitted(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ allowed: boolean }>(
    "select core.has_permission('threads.use') allowed",
  );
  return rows[0]?.allowed === true;
}

/** Newest version of each document the caller can read; missing ids are left out. */
async function latestVersions(db: Db, ids: readonly string[]): Promise<DocumentRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<DocumentRow>(
    `select distinct on (d.id) ${DOCUMENT_COLUMNS}
       from content.document d
       join content.document_version v on v.document_id = d.id
      where d.id = any($1::uuid[])
      order by d.id, v.version_no desc`,
    [ids],
  );
  return rows;
}

interface RunRow {
  id: string;
  kind: RunView["kind"];
  status: RunStatus;
  thread_id: string;
  question_id: string;
  answer_id: string | null;
  coverage: Coverage | null;
  plan: unknown;
  model: string | null;
  cost_usd: string;
}

const toRun = (row: RunRow): RunView => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  threadId: row.thread_id,
  questionId: row.question_id,
  answerId: row.answer_id,
  coverage: row.coverage,
  plan: row.plan,
  model: row.model,
  costUsd: Number(row.cost_usd),
});

const RUN_COLUMNS =
  "id, kind, status, thread_id, question_id, answer_id, coverage, plan, model, cost_usd";

async function load(db: Db, principal: Principal, threadId: string): Promise<ThreadView | null> {
  const { rows: found } = await db.query<{
    id: string;
    title: string;
    matter_id: string | null;
    owner_id: string;
    vault_ids: string[];
    sources: SourceSelection[];
    created_at: Date;
  }>(
    "select id, title, matter_id, owner_id, vault_ids, sources, created_at from work.thread where id = $1",
    [threadId],
  );
  const thread = found[0];
  if (!thread) return null;

  const { rows: documents } = await db.query<DocumentRow>(
    `select ${DOCUMENT_COLUMNS}
       from work.thread_document td
       join content.document_version v on v.id = td.version_id
       join content.document d on d.id = v.document_id
      where td.thread_id = $1
      order by d.id`,
    [threadId],
  );
  // A turn's two messages share a timestamp, so the question is put first explicitly.
  const { rows: messages } = await db.query<{
    id: string;
    role: "user" | "assistant";
    content: string;
    model: string | null;
    requested_model: string | null;
    fallback: boolean;
    input_tokens: number | null;
    output_tokens: number | null;
    cost_usd: string | null;
    ungrounded: Range[];
    created_at: Date;
  }>(
    `select id, role, content, model, requested_model, fallback, input_tokens, output_tokens,
            cost_usd, ungrounded, created_at
       from work.message
      where thread_id = $1 order by created_at, role = 'assistant', id`,
    [threadId],
  );
  const { rows: citations } = await db.query<{
    message_id: string;
    ordinal: number;
    anchor: number;
    kind: "document" | "authority";
    version_id: string | null;
    version_no: number | null;
    document_id: string | null;
    name: string | null;
    page_no: number | null;
    quote: string | null;
    char_from: number | null;
    char_to: number | null;
    status: CitationStatus;
    authority_id: string | null;
    authority_citation: string | null;
    authority_title: string | null;
    authority_url: string | null;
  }>(
    `select c.message_id, c.ordinal, c.anchor, c.kind, c.version_id, v.version_no, v.document_id,
            d.name, c.page_no, c.quote, c.char_from, c.char_to, c.status, c.authority_id,
            c.authority_citation, c.authority_title, c.authority_url
       from work.citation c
       join work.message m on m.id = c.message_id
       left join content.document_version v on v.id = c.version_id
       left join content.document d on d.id = v.document_id
      where m.thread_id = $1
      order by c.message_id, c.ordinal`,
    [threadId],
  );
  const { rows: runs } = await db.query<RunRow>(
    `select ${RUN_COLUMNS} from work.run where thread_id = $1 order by id`,
    [threadId],
  );

  return {
    id: thread.id,
    title: thread.title,
    matterId: thread.matter_id,
    createdAt: thread.created_at.toISOString(),
    mine: thread.owner_id === principal.userId,
    vaultIds: thread.vault_ids,
    sources: thread.sources,
    documents: documents.map(toDocument),
    runs: runs.map(toRun),
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      model: message.model,
      requestedModel: message.requested_model,
      fallback: message.fallback,
      inputTokens: message.input_tokens,
      outputTokens: message.output_tokens,
      costUsd: message.cost_usd === null ? null : Number(message.cost_usd),
      ungrounded: message.ungrounded,
      createdAt: message.created_at.toISOString(),
      citations: citations
        .filter((citation) => citation.message_id === message.id)
        .map((citation) => ({
          n: citation.ordinal + 1,
          at: citation.anchor,
          kind: citation.kind,
          documentId: citation.document_id,
          versionId: citation.version_id,
          versionNo: citation.version_no,
          documentName: citation.name,
          page: citation.page_no,
          quote: citation.quote,
          from: citation.char_from,
          to: citation.char_to,
          status: citation.status,
          authority:
            citation.authority_id === null
              ? null
              : {
                  id: citation.authority_id,
                  citation: citation.authority_citation ?? "",
                  title: citation.authority_title ?? "",
                  url: citation.authority_url ?? "",
                },
        })),
    })),
  };
}

const audit = (
  db: Db,
  principal: Principal,
  action: string,
  threadId: string,
  details: object,
  client: Client,
) =>
  // Ids and numbers only: questions and answers stay out of the audit log.
  db.query("select admin.append_audit_event($1, 'user', $2, 'thread', $3, $4, $5, $6)", [
    action,
    principal.userId,
    threadId,
    JSON.stringify(details),
    client.ip,
    uaHash(client),
  ]);

/** The run was cancelled or failed while its answer was being saved. */
class RunStopped extends Error {}

// Reading stops at 45 minutes; this leaves the report room to finish.
const DEEP_DEADLINE_MS = 50 * 60_000;

const RUN_MESSAGES = {
  MODEL_NOT_ALLOWED: "That model isn't available to you.",
  MODEL_UNAVAILABLE: "No model could answer just now. Try again shortly.",
  STREAM_INTERRUPTED: "The model stopped part way through. Try again.",
};

export function createThreads(pool: pg.Pool, options: ThreadsOptions): Threads {
  const { log, vaults } = options;
  const answer = createAnswerer({ pool, ...options });
  const inFlight = new Set<Promise<void>>();
  // Runs this process is working on, so a cancel can stop the model mid-answer.
  const active = new Map<string, AbortController>();
  const cancelled = (runId: string) => active.get(runId)?.signal.aborted === true;

  async function save(
    db: Db,
    principal: Principal,
    run: { id: string; threadId: string },
    reply: Answer,
    documents: readonly ScopeDocument[],
    client: Client,
    /** What earlier steps of the run spent, such as deep analysis reading. */
    spent = 0,
  ): Promise<string> {
    const { workspaceId } = principal;
    const model = reply.model;
    // A cited vault document joins the thread, so its citation stays readable here.
    const cited = new Set(reply.citations.map((citation) => citation.versionId));
    const joining = documents.filter((document) => cited.has(document.versionId));
    if (joining.length > 0) {
      await db.query(
        `insert into work.thread_document (workspace_id, thread_id, version_id)
         select $1, $2, unnest($3::uuid[]) on conflict do nothing`,
        [workspaceId, run.threadId, joining.map((document) => document.versionId)],
      );
    }
    const { rows } = await db.query<{ id: string }>(
      `insert into work.message
         (workspace_id, thread_id, role, content, model, input_tokens, output_tokens,
          tokens_estimated, cost_usd, response_mode, requested_model, fallback, ungrounded)
       values ($1, $2, 'assistant', $3, $4, $5, $6, $7, $8, 'answer', $9, $10, $11) returning id`,
      [
        workspaceId,
        run.threadId,
        reply.text,
        model?.model ?? null,
        model?.usage.input_tokens ?? null,
        model?.usage.output_tokens ?? null,
        model?.usage.estimated ?? null,
        model?.cost_usd ?? null,
        model?.requested_model ?? null,
        model?.fallback ?? false,
        JSON.stringify(reply.ungrounded),
      ],
    );
    const messageId = rows[0]?.id;
    if (!messageId) throw new Error("insert returned no message");

    const citations = reply.citations;
    if (citations.length > 0) {
      const column = <T>(pick: (citation: Checked) => T) => citations.map(pick);
      await db.query(
        `insert into work.citation
           (workspace_id, message_id, ordinal, anchor, kind, version_id, page_no, quote, char_from,
            char_to, status, authority_id, authority_citation, authority_title, authority_url)
         select $1, $2, * from unnest($3::int[], $4::int[], $5::text[], $6::uuid[], $7::int[],
                                     $8::text[], $9::int[], $10::int[], $11::text[], $12::text[],
                                     $13::text[], $14::text[], $15::text[])`,
        [
          workspaceId,
          messageId,
          column((c) => c.n - 1),
          column((c) => c.at),
          column((c) => c.kind),
          column((c) => c.versionId),
          column((c) => c.page),
          column((c) => c.quote),
          column((c) => c.from),
          column((c) => c.to),
          column((c) => c.status),
          column((c) => c.authority?.authority_id ?? null),
          column((c) => c.authority?.citation_string.slice(0, 500) ?? null),
          column((c) => c.authority?.title.slice(0, 500) ?? null),
          column((c) => c.authority?.url.slice(0, 2000) ?? null),
        ],
      );
    }
    // Only a run still going can finish, so a cancel that lands mid-save wins.
    const finished = await db.query(
      `update work.run set status = 'done', answer_id = $2, coverage = $3, model = $4,
              cost_usd = $5, updated_at = now() where id = $1 and status = 'running'`,
      [
        run.id,
        messageId,
        JSON.stringify(reply.coverage),
        model?.model ?? null,
        (model?.cost_usd ?? 0) + spent,
      ],
    );
    if (finished.rowCount === 0) throw new RunStopped();
    await db.query("update work.thread set last_activity_at = now() where id = $1", [run.threadId]);
    if (model) {
      const count = (status: CitationStatus) =>
        citations.filter((citation) => citation.status === status).length;
      await audit(
        db,
        principal,
        "model.call",
        run.threadId,
        {
          message_id: messageId,
          model: model.model,
          input_tokens: model.usage.input_tokens,
          output_tokens: model.usage.output_tokens,
          tokens_estimated: model.usage.estimated,
          cost_usd: model.cost_usd,
          latency_ms: model.latency_ms,
          citations: {
            ok: count("ok"),
            mismatch: count("mismatch"),
            unresolved: count("unresolved"),
          },
          ungrounded_sentences: reply.ungrounded.length,
        },
        client,
      );
    }
    return messageId;
  }

  async function fail(
    principal: Principal,
    runId: string,
    code: string,
    message: string,
    retryable: boolean,
  ) {
    const changed = await asApp(pool, principal, (db) =>
      db.query(
        "update work.run set status = 'failed', updated_at = now() where id = $1 and status = 'running'",
        [runId],
      ),
    );
    if (changed.rowCount === 0) return;
    await log.append(principal, runId, { type: "error", code, message, retryable });
    // The status closes every open stream, retryable or not.
    await log.append(principal, runId, { type: "status", status: "failed" });
  }

  function track(work: Promise<void>) {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
    return work;
  }

  /** Plans a deep analysis and stops at awaiting_approval; nothing is spent on models yet. */
  async function plan(
    principal: Principal,
    run: { id: string; threadId: string },
    documents: ThreadDocument[],
    question: string,
    focus: string | null,
  ) {
    const emit = (event: NewEvent) => log.append(principal, run.id, event);
    // A re-plan keeps the old plan if it fails, so it never reports the run as planned or failed.
    const replanning = focus !== null;
    try {
      if (!replanning) await emit({ type: "status", status: "planned" });
      const stored = await planDeep({ pool, ...options }, principal, documents, question, focus);
      const saved = await asApp(pool, principal, (db) =>
        db.query(
          `update work.run set plan = $2, status = 'awaiting_approval', updated_at = now()
            where id = $1 and status in ('planned', 'awaiting_approval')`,
          [run.id, JSON.stringify(stored)],
        ),
      );
      if (saved.rowCount === 0) return;
      const { scope: _scope, ...shown } = stored;
      await emit({ type: "plan", plan: shown });
      if (!replanning) await emit({ type: "status", status: "awaiting_approval" });
    } catch (err) {
      console.error(`plan ${run.id} failed: ${err instanceof Error ? err.name : "unknown"}`);
      if (replanning) return;
      await asApp(pool, principal, (db) =>
        db.query("update work.run set status = 'failed' where id = $1 and status = 'planned'", [
          run.id,
        ]),
      ).catch(() => {});
      await log.append(principal, run.id, { type: "status", status: "failed" }).catch(() => {});
    } finally {
      // An approved run may already be writing to this log; its own work releases it.
      if (!active.has(run.id)) log.release(run.id);
    }
  }

  /** Reads the approved plan's files with bounded readers, then writes a verified report. */
  async function executeDeep(
    principal: Principal,
    run: { id: string; threadId: string },
    stored: StoredPlan,
    client: Client,
  ) {
    const started = Date.now();
    const emit = (event: NewEvent) => log.append(principal, run.id, event);
    const controller = new AbortController();
    active.set(run.id, controller);
    try {
      await emit({ type: "status", status: "running" });
      const read = await readDeep(
        { pool, ...options },
        {
          principal,
          scope: stored.scope,
          emit,
          cancelled: () => cancelled(run.id),
          // Cancel or the deadline stops a model call mid-flight, not only between files.
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(DEEP_DEADLINE_MS)]),
          budgetUsd: stored.estimated_cost_usd.high,
        },
      );
      if (cancelled(run.id)) {
        // What reading cost is kept even when the report is never written.
        await asApp(pool, principal, (db) =>
          db.query("update work.run set cost_usd = $2 where id = $1", [run.id, read.costUsd]),
        ).catch(() => {});
        return;
      }
      const cited = new Set(read.findings.map((finding) => finding.document.versionId));
      const documents = stored.scope.read.filter((d) => cited.has(d.versionId));
      const note = `\n\n${coverageNote(read.coverage, read.unread)}`;
      let reply: Answer;
      if (read.findings.length === 0) {
        const text = `None of the files read had anything relevant to this question.${note}`;
        await emit({ type: "token", message_id: run.id, delta: text });
        reply = { text, model: null, citations: [], ungrounded: [], coverage: read.coverage };
      } else {
        const answered = await answer(
          {
            principal,
            documents,
            sources: [],
            history: [],
            question: stored.scope.focus
              ? `${stored.scope.question}\nFocus: ${stored.scope.focus}`
              : stored.scope.question,
            emit,
            cancelled: () => cancelled(run.id),
            signal: controller.signal,
            prepared: { passages: read.passages, coverage: read.coverage },
            shape: REPORT_SHAPE,
          },
          run.id,
        );
        if (answered === "CANCELLED" || cancelled(run.id)) return;
        if (typeof answered === "string") {
          await fail(
            principal,
            run.id,
            answered,
            RUN_MESSAGES[answered],
            answered !== "MODEL_NOT_ALLOWED",
          );
          return;
        }
        // The coverage line is the run's own record, added after grounding so it is never flagged.
        await emit({ type: "token", message_id: run.id, delta: note });
        reply = { ...answered, text: `${answered.text}${note}`, coverage: read.coverage };
      }
      await emit({ type: "status", status: "verifying" });
      let messageId: string;
      try {
        messageId = await asApp(pool, principal, (db) =>
          save(db, principal, run, reply, documents, client, read.costUsd),
        );
      } catch (err) {
        if (err instanceof RunStopped) return;
        if (isRefusal(err)) {
          await fail(
            principal,
            run.id,
            "WALL_DENIED",
            "You no longer have access to this thread.",
            false,
          );
          return;
        }
        throw err;
      }
      const count = (status: CitationStatus) =>
        reply.citations.filter((citation) => citation.status === status).length;
      await emit({
        type: "done",
        message_id: messageId,
        model: reply.model?.model ?? null,
        response_mode: "answer",
        usage: {
          input_tokens: read.usage.input_tokens + (reply.model?.usage.input_tokens ?? 0),
          output_tokens: read.usage.output_tokens + (reply.model?.usage.output_tokens ?? 0),
        },
        cost_usd: read.costUsd + (reply.model?.cost_usd ?? 0),
        citations: {
          total: reply.citations.length,
          ok: count("ok"),
          mismatch: count("mismatch"),
          unresolved: count("unresolved"),
          ungrounded_sentences: reply.ungrounded.length,
        },
        ungrounded: reply.ungrounded.map(([from, to]): [number, number] => [from, to]),
        coverage: read.coverage,
        duration_ms: Date.now() - started,
      });
    } catch (err) {
      console.error(`run ${run.id} failed: ${err instanceof Error ? err.name : "unknown"}`);
      await fail(
        principal,
        run.id,
        "INTERNAL",
        "Something went wrong in this analysis.",
        true,
      ).catch(() => {});
    } finally {
      active.delete(run.id);
      log.release(run.id);
    }
  }

  async function execute(
    principal: Principal,
    run: { id: string; threadId: string },
    documents: ThreadDocument[],
    context: { question: string; history: { role: "user" | "assistant"; content: string }[] },
    input: AskInput,
    client: Client,
  ) {
    const started = Date.now();
    const emit = (event: NewEvent) => log.append(principal, run.id, event);
    const responseMode = input.responseMode ?? "auto";
    const controller = new AbortController();
    active.set(run.id, controller);
    try {
      await emit({ type: "status", status: "running" });
      // Streamed tokens carry the run id; the saved answer gets its own id at the end.
      const reply = await answer(
        {
          principal,
          documents,
          sources: input.scope.sources,
          history: context.history,
          question: context.question,
          ...(input.model ? { model: input.model } : {}),
          emit,
          cancelled: () => cancelled(run.id),
          signal: controller.signal,
        },
        run.id,
      );
      if (reply === "CANCELLED" || cancelled(run.id)) return;
      if (typeof reply === "string") {
        await fail(principal, run.id, reply, RUN_MESSAGES[reply], reply !== "MODEL_NOT_ALLOWED");
        return;
      }
      await emit({ type: "status", status: "verifying" });
      let messageId: string;
      try {
        messageId = await asApp(pool, principal, (db) =>
          save(db, principal, run, reply, documents, client),
        );
      } catch (err) {
        if (err instanceof RunStopped) return;
        // A wall or permission can change while the model is answering.
        if (isRefusal(err)) {
          await fail(
            principal,
            run.id,
            "WALL_DENIED",
            "You no longer have access to this thread.",
            false,
          );
          return;
        }
        throw err;
      }
      const count = (status: CitationStatus) =>
        reply.citations.filter((citation) => citation.status === status).length;
      await emit({
        type: "done",
        message_id: messageId,
        model: reply.model?.model ?? null,
        response_mode: responseMode === "auto" ? "answer" : responseMode,
        usage: {
          input_tokens: reply.model?.usage.input_tokens ?? 0,
          output_tokens: reply.model?.usage.output_tokens ?? 0,
        },
        cost_usd: reply.model?.cost_usd ?? 0,
        citations: {
          total: reply.citations.length,
          ok: count("ok"),
          mismatch: count("mismatch"),
          unresolved: count("unresolved"),
          ungrounded_sentences: reply.ungrounded.length,
        },
        ungrounded: reply.ungrounded.map(([from, to]): [number, number] => [from, to]),
        coverage: reply.coverage,
        duration_ms: Date.now() - started,
      });
    } catch (err) {
      // The name only: a message can quote the prompt.
      console.error(`run ${run.id} failed: ${err instanceof Error ? err.name : "unknown"}`);
      await fail(principal, run.id, "INTERNAL", "Something went wrong answering this.", true).catch(
        () => {},
      );
    } finally {
      active.delete(run.id);
      log.release(run.id);
    }
  }

  return {
    async ask(principal, input, client) {
      const question = questionText(input.blocks);
      if (input.threadId !== undefined && !UUID.test(input.threadId)) {
        return { ok: false, reason: "NOT_FOUND" };
      }
      // A mentioned file, vault or source is in scope for this turn even if it wasn't attached.
      const mentioned = (type: string) =>
        input.blocks.flatMap((b) =>
          b.type === "mention" && b.ref_type === type ? [b.ref_id] : [],
        );
      const documentIds = [...new Set([...input.scope.document_ids, ...mentioned("document")])];
      const vaultIds = [...new Set([...input.scope.vault_ids, ...mentioned("vault")])].slice(0, 2);
      const sourceIds = new Set(input.scope.sources.map((source) => source.source_id));
      const sources = [
        ...input.scope.sources,
        ...mentioned("source")
          .filter((id) => !sourceIds.has(id))
          .map((source_id) => ({ source_id })),
      ].slice(0, 5);
      if (![...documentIds, ...vaultIds].every((id) => UUID.test(id))) {
        return { ok: false, reason: "NOT_FOUND" };
      }
      if (
        input.model !== undefined &&
        !options.gateway.models("synthesize").some((m) => m.id === input.model)
      ) {
        return { ok: false, reason: "MODEL_NOT_ALLOWED" };
      }
      const fromVaults = vaultIds.length
        ? await vaults.documentIds(principal, vaultIds, VAULT_DOCUMENTS)
        : [];

      const prepared = await asApp(pool, principal, async (db) => {
        if (!(await permitted(db))) return "FORBIDDEN" as const;
        const existing = input.threadId ? await load(db, principal, input.threadId) : null;
        if (input.threadId && !existing) return "NOT_FOUND" as const;
        if (existing && !existing.mine) return "READ_ONLY" as const;
        const chosen = await latestVersions(db, documentIds);
        if (chosen.length !== documentIds.length) return "NOT_FOUND" as const;
        const matters = new Set(chosen.map((row) => row.matter_id));
        const matterId = existing
          ? existing.matterId
          : (input.matterId ?? chosen[0]?.matter_id ?? null);
        if (matters.size > 1 || (chosen.length > 0 && !matters.has(matterId))) {
          return "MIXED_MATTERS" as const;
        }
        // Vault files outside the thread's matter stay out, so one wall covers the thread.
        const vaultDocs = (await latestVersions(db, fromVaults)).filter(
          (row) => row.matter_id === matterId,
        );
        return { existing, chosen, vaultDocs, matterId };
      });
      if (typeof prepared === "string") return { ok: false, reason: prepared };
      const { existing, chosen, vaultDocs, matterId } = prepared;

      const held = new Map((existing?.documents ?? []).map((d) => [d.id, d]));
      for (const row of chosen) if (!held.has(row.id)) held.set(row.id, toDocument(row));
      const attached = [...held.values()].sort((a, b) => a.id.localeCompare(b.id));
      const inScope = [...attached];
      for (const row of vaultDocs) if (!held.has(row.id)) inScope.push(toDocument(row));
      if (inScope.length === 0 && sources.length === 0) {
        return { ok: false, reason: "EMPTY_SCOPE" };
      }

      let created: { threadId: string; questionId: string; runId: string };
      try {
        created = await asApp(pool, principal, async (db) => {
          let threadId = existing?.id;
          if (!threadId) {
            const { rows } = await db.query<{ id: string }>(
              `insert into work.thread (workspace_id, owner_id, matter_id, title, vault_ids, sources)
               values ($1, $2, $3, $4, $5, $6) returning id`,
              [
                principal.workspaceId,
                principal.userId,
                matterId,
                titleOf(question),
                vaultIds,
                JSON.stringify(sources),
              ],
            );
            threadId = rows[0]?.id;
            if (!threadId) throw new Error("insert returned no thread");
            await audit(
              db,
              principal,
              "thread.created",
              threadId,
              { document_count: attached.length, matter_id: matterId },
              client,
            );
          } else {
            // Scope changes apply from this turn on; earlier answers keep theirs.
            await db.query(
              "update work.thread set vault_ids = $2, sources = $3, last_activity_at = now() where id = $1",
              [threadId, vaultIds, JSON.stringify(sources)],
            );
          }
          const added = attached.filter((d) => !existing?.documents.some((e) => e.id === d.id));
          if (added.length > 0) {
            await db.query(
              `insert into work.thread_document (workspace_id, thread_id, version_id)
               select $1, $2, unnest($3::uuid[])`,
              [principal.workspaceId, threadId, added.map((d) => d.versionId)],
            );
          }
          const { rows: q } = await db.query<{ id: string }>(
            `insert into work.message
               (workspace_id, thread_id, role, content, blocks, response_mode, requested_model)
             values ($1, $2, 'user', $3, $4, $5, $6) returning id`,
            [
              principal.workspaceId,
              threadId,
              question,
              JSON.stringify(input.blocks),
              input.responseMode ?? "auto",
              input.model ?? null,
            ],
          );
          const questionId = q[0]?.id;
          if (!questionId) throw new Error("insert returned no message");
          const { rows: r } = await db.query<{ id: string }>(
            `insert into work.run (workspace_id, thread_id, owner_id, kind, status, question_id)
             values ($1, $2, $3, $4, $5, $6) returning id`,
            [
              principal.workspaceId,
              threadId,
              principal.userId,
              input.deepAnalysis ? "deep_analysis" : "thread",
              input.deepAnalysis ? "planned" : "running",
              questionId,
            ],
          );
          const runId = r[0]?.id;
          if (!runId) throw new Error("insert returned no run");
          return { threadId, questionId, runId };
        });
      } catch (err) {
        if (isRefusal(err)) return { ok: false, reason: "FORBIDDEN" };
        throw err;
      }

      const history = (existing?.messages ?? []).slice(-HISTORY_MESSAGES).map((message) => ({
        role: message.role,
        content: message.content.slice(0, HISTORY_CHARS),
      }));
      const run = { id: created.runId, threadId: created.threadId };
      const finished = track(
        input.deepAnalysis
          ? plan(principal, run, inScope, question, null)
          : execute(
              principal,
              run,
              inScope,
              { question, history },
              { ...input, scope: { ...input.scope, sources } },
              client,
            ),
      );
      return { ok: true, ...created, finished };
    },

    async get(principal, threadId) {
      if (!UUID.test(threadId)) return null;
      return asApp(pool, principal, (db) => load(db, principal, threadId));
    },

    async history(principal, filters) {
      const [cursorAt = "", cursorId = ""] = (filters.cursor ?? "").split("|");
      const cursor = UUID.test(cursorId) && !Number.isNaN(Date.parse(cursorAt));
      const docs = filters.docs ? DOC_BUCKETS[filters.docs] : null;
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{
          id: string;
          title: string;
          matter_id: string | null;
          owner_id: string;
          last_activity_at: Date;
          document_count: number;
          model: string | null;
          cost: string;
          run_status: RunStatus | null;
          deep: boolean;
          favourite: boolean;
        }>(
          `with listed as (
             select t.id, t.title, t.matter_id, t.owner_id, t.last_activity_at,
                    (select count(*)::int from work.thread_document td
                      where td.thread_id = t.id) document_count,
                    (select m.model from work.message m
                      where m.thread_id = t.id and m.role = 'assistant'
                      order by m.created_at desc limit 1) model,
                    (select coalesce(sum(m.cost_usd), 0) from work.message m
                      where m.thread_id = t.id) cost,
                    (select r.status from work.run r where r.thread_id = t.id
                      order by r.id desc limit 1) run_status,
                    exists (select 1 from work.run r
                             where r.thread_id = t.id and r.kind = 'deep_analysis') deep,
                    exists (select 1 from work.thread_favourite f where f.thread_id = t.id) favourite
               from work.thread t
              -- Other people's prompts are never searched, only titles of threads shared with you.
              where ($1 = '' or t.title ilike $1 or (t.owner_id = core.current_user_id() and exists (
                       select 1 from work.message m
                        where m.thread_id = t.id and m.role = 'user' and m.content ilike $1)))
                and ($2::timestamptz is null or t.last_activity_at >= $2)
                and ($3::timestamptz is null or t.last_activity_at < $3)
                and ($4::timestamptz is null or (t.last_activity_at, t.id) < ($4, $5::uuid)))
           select * from listed
            where ($6::text is null or ($6 = 'deep_analysis') = deep)
              and ($7::int is null or document_count between $7 and $8)
              and (not $9 or favourite)
            order by last_activity_at desc, id desc
            limit $10`,
          [
            filters.q ? likePattern(filters.q.slice(0, 200)) : "",
            filters.from ?? null,
            filters.to ?? null,
            cursor ? cursorAt : null,
            cursor ? cursorId : null,
            filters.type ?? null,
            docs?.[0] ?? null,
            docs?.[1] ?? null,
            filters.favourites === true,
            PAGE + 1,
          ],
        );
        const page = rows.slice(0, PAGE);
        const last = page.at(-1);
        const statusOf = (status: RunStatus | null): HistoryRow["status"] => {
          if (status === null || status === "done" || status === "cancelled") return "done";
          if (status === "failed") return "failed";
          if (status === "awaiting_approval" || status === "awaiting_input") return "needs_input";
          return "running";
        };
        return {
          rows: page.map((row) => ({
            id: row.id,
            title: row.title,
            type: row.deep ? ("deep_analysis" as const) : ("assist" as const),
            matterId: row.matter_id,
            documentCount: row.document_count,
            model: row.model,
            costUsd: Number(row.cost),
            lastActivityAt: row.last_activity_at.toISOString(),
            status: statusOf(row.run_status),
            favourite: row.favourite,
            shared: row.owner_id !== principal.userId,
          })),
          nextCursor:
            rows.length > PAGE && last ? `${last.last_activity_at.toISOString()}|${last.id}` : null,
        };
      });
    },

    async run(principal, runId) {
      if (!UUID.test(runId)) return null;
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<RunRow>(
          `select ${RUN_COLUMNS} from work.run where id = $1`,
          [runId],
        );
        return rows[0] ? toRun(rows[0]) : null;
      });
    },

    async approve(principal, runId, client) {
      if (!UUID.test(runId)) return false;
      const approved = await asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ thread_id: string; plan: StoredPlan }>(
          `update work.run set status = 'running', updated_at = now()
            where id = $1 and kind = 'deep_analysis' and status = 'awaiting_approval'
              and owner_id = $2
            returning thread_id, plan`,
          [runId, principal.userId],
        );
        const row = rows[0];
        if (row) {
          await audit(
            db,
            principal,
            "run.approved",
            row.thread_id,
            {
              run_id: runId,
              files_to_read: row.plan.scope.read.length,
              files_not_read: row.plan.scope.skipped.length,
              estimated_cost_usd: row.plan.estimated_cost_usd,
            },
            client,
          );
        }
        return row ?? null;
      });
      if (!approved) return false;
      track(
        executeDeep(principal, { id: runId, threadId: approved.thread_id }, approved.plan, client),
      );
      return true;
    },

    async editPlan(principal, runId, instruction, client) {
      if (!UUID.test(runId)) return false;
      const current = await asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ thread_id: string; plan: StoredPlan | null }>(
          `select thread_id, plan from work.run
            where id = $1 and kind = 'deep_analysis' and status = 'awaiting_approval'
              and owner_id = $2`,
          [runId, principal.userId],
        );
        return rows[0] ?? null;
      });
      if (!current?.plan) return false;
      // The instruction's length only: what the user typed stays out of the audit log.
      await asApp(pool, principal, (db) =>
        audit(
          db,
          principal,
          "run.plan_edited",
          current.thread_id,
          { run_id: runId, instruction_chars: instruction.length },
          client,
        ),
      );
      const { scope } = current.plan;
      const documents = [...scope.read, ...scope.skipped.map((s) => s.document)].map((d) => ({
        ...d,
        emptyPageCount: 0,
      }));
      await track(
        plan(
          principal,
          { id: runId, threadId: current.thread_id },
          documents,
          scope.question,
          instruction,
        ),
      );
      return true;
    },

    async cancel(principal, runId, client) {
      if (!UUID.test(runId)) return false;
      const stopped = await asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ thread_id: string }>(
          `update work.run set status = 'cancelled', updated_at = now()
            where id = $1 and owner_id = $2 and status not in ('done', 'failed', 'cancelled')
            returning thread_id`,
          [runId, principal.userId],
        );
        const threadId = rows[0]?.thread_id;
        if (threadId) {
          await audit(db, principal, "run.cancelled", threadId, { run_id: runId }, client);
        }
        return threadId !== undefined;
      });
      if (!stopped) return false;
      active.get(runId)?.abort();
      await log.append(principal, runId, { type: "status", status: "cancelled" });
      return true;
    },

    async favourite(principal, threadId, on) {
      if (!UUID.test(threadId)) return false;
      return asApp(pool, principal, async (db) => {
        const visible = await db.query("select 1 from work.thread where id = $1", [threadId]);
        if (visible.rowCount === 0) return false;
        await db.query(
          on
            ? `insert into work.thread_favourite (workspace_id, thread_id, user_id)
               values ($1, $2, $3) on conflict do nothing`
            : `delete from work.thread_favourite
                where workspace_id = $1 and thread_id = $2 and user_id = $3`,
          [principal.workspaceId, threadId, principal.userId],
        );
        return true;
      });
    },

    async share(principal, threadId, { userIds, link }, client) {
      if (!UUID.test(threadId) || !userIds.every((id) => UUID.test(id))) {
        return { ok: false, reason: "NOT_FOUND" };
      }
      try {
        return await asApp(pool, principal, async (db) => {
          const { rows } = await db.query<{
            principal_id: string;
            outcome: ShareOutcome["outcome"];
          }>("select principal_id, outcome from work.share_thread($1, $2::uuid[], $3)", [
            threadId,
            [...new Set(userIds)],
            link,
          ]);
          const created = rows.filter((row) => row.outcome === "created").length;
          if (created > 0) {
            await audit(
              db,
              principal,
              "thread.shared",
              threadId,
              { recipients: created, link },
              client,
            );
          }
          return {
            ok: true as const,
            outcomes: rows
              .filter((row) => row.principal_id !== principal.workspaceId)
              .map((row) => ({ userId: row.principal_id, outcome: row.outcome })),
          };
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        if (message.includes("WALL_MISMATCH")) return { ok: false, reason: "WALL_MISMATCH" };
        if (message.includes("thread not found")) return { ok: false, reason: "NOT_FOUND" };
        throw err;
      }
    },

    async shares(principal, threadId) {
      if (!UUID.test(threadId)) return null;
      return asApp(pool, principal, async (db) => {
        const owned = await db.query("select 1 from work.thread where id = $1 and owner_id = $2", [
          threadId,
          principal.userId,
        ]);
        if (owned.rowCount === 0) return null;
        const { rows } = await db.query<{
          id: string;
          principal_type: "user" | "workspace";
          principal_id: string;
          email: string | null;
          granted_at: Date;
        }>(
          "select id, principal_type, principal_id, email, granted_at from work.thread_shares($1)",
          [threadId],
        );
        return rows.map((row) => ({
          id: row.id,
          principalType: row.principal_type,
          principalId: row.principal_id,
          email: row.email,
          grantedAt: row.granted_at.toISOString(),
        }));
      });
    },

    async revoke(principal, threadId, shareId, client) {
      if (!UUID.test(threadId) || !UUID.test(shareId)) return false;
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ ok: boolean }>(
          "select work.revoke_thread_share($1, $2) ok",
          [threadId, shareId],
        );
        if (rows[0]?.ok !== true) return false;
        await audit(db, principal, "thread.share_revoked", threadId, { share_id: shareId }, client);
        return true;
      });
    },

    async duplicate(principal, threadId, client) {
      if (!UUID.test(threadId)) return null;
      try {
        return await asApp(pool, principal, async (db) => {
          if (!(await permitted(db))) return null;
          const source = await load(db, principal, threadId);
          if (!source) return null;
          const { rows } = await db.query<{ id: string }>(
            `insert into work.thread (workspace_id, owner_id, matter_id, title, vault_ids, sources)
             values ($1, $2, $3, $4, $5, $6) returning id`,
            [
              principal.workspaceId,
              principal.userId,
              source.matterId,
              titleOf(`Copy of ${source.title}`),
              source.vaultIds,
              JSON.stringify(source.sources),
            ],
          );
          const copy = rows[0]?.id;
          if (!copy) throw new Error("insert returned no thread");
          // Only the files the caller can read themselves come along.
          const readable = new Set(
            (
              await latestVersions(
                db,
                source.documents.map((d) => d.id),
              )
            ).map((r) => r.id),
          );
          const kept = source.documents.filter((d) => readable.has(d.id));
          if (kept.length > 0) {
            await db.query(
              `insert into work.thread_document (workspace_id, thread_id, version_id)
               select $1, $2, unnest($3::uuid[])`,
              [principal.workspaceId, copy, kept.map((d) => d.versionId)],
            );
          }
          await audit(
            db,
            principal,
            "thread.duplicated",
            copy,
            { from: threadId, document_count: kept.length },
            client,
          );
          return copy;
        });
      } catch (err) {
        if (isRefusal(err)) return null;
        throw err;
      }
    },

    async members(principal, query) {
      return asApp(pool, principal, async (db) => {
        // Only people who can share threads get to look colleagues up.
        if (!(await permitted(db))) return [];
        const { rows } = await db.query<Member>(
          `select id, email, name from core."user"
            where status = 'active' and kind = 'member' and id <> $1
              and ($2 = '' or email ilike $2 or name ilike $2)
            order by email limit $3`,
          [principal.userId, query ? likePattern(query.slice(0, 100)) : "", MEMBERS],
        );
        return rows;
      });
    },

    async settled() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}
