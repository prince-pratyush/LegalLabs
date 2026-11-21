import { createHash, randomUUID } from "node:crypto";
import type { AgentAttachment, AgentSource, RoutingClass } from "@legallabs/contracts";
import type { Gateway, Message } from "@legallabs/model-gateway";
import type { RunContext, RunHandler, StepRecord } from "@legallabs/runs";
import type pg from "pg";
import { asApp } from "../db.js";
import type { ContextPort } from "./context.js";

const TASK_CLASS = {
  extract: "read_extract",
  draft: "draft_edit",
  summarise: "synthesize",
  reason: "synthesize",
} as const;

/** Whether a model may be used for a class under this workspace and matter (agents-workflows.md §4.13). */
export interface ModelPolicy {
  eligible(
    who: { workspaceId: string; userId: string },
    matterId: string | null,
    cls: RoutingClass,
  ): Promise<boolean>;
}
export const anyModel: ModelPolicy = { eligible: async () => true };

/** Checks the final text, such as its citations; the default accepts it. */
export interface RunVerifier {
  verify(
    ctx: RunContext,
    text: string,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}

export interface AgentHandlerDeps {
  pool: pg.Pool;
  gateway: Gateway;
  context: ContextPort;
  policy?: ModelPolicy;
  verifier?: RunVerifier;
  /** Characters of attached material sent to the model. */
  contextChars?: number;
  /** Records a wall hit, so the audit trail shows an attachment was left out. */
  onWallDenied?: (
    who: { workspaceId: string; userId: string },
    runId: string,
    label: string,
  ) => Promise<void>;
}

const SYSTEM = [
  "You run a saved agent for a legal professional. Follow the agent's instructions exactly.",
  "Use only the material provided below the instructions and the person's inputs. Never invent sources, cases or quotations.",
  "Refer to attached material by its @label. If something needed is missing from it, say so.",
  "If you cannot continue without an answer from the person, reply with a single line starting with ASK: followed by JSON",
  '{"question": string, "options": [{"id": string, "label": string}], "allow_text": boolean} and nothing else.',
].join(" ");

const ASK = /^ASK:\s*(\{[\s\S]*\})\s*$/;
const MAX_OUTPUT = 4000;

interface Loaded {
  version_id: string;
  instructions: string;
  attachments: AgentAttachment[];
  sources: AgentSource[];
}

interface StoredPlan {
  usable?: AgentAttachment[];
  left_out?: string[];
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function createAgentHandler(deps: AgentHandlerDeps): RunHandler {
  const policy = deps.policy ?? anyModel;
  const contextChars = deps.contextChars ?? 60_000;
  const principal = (run: { owner_id: string; workspace_id: string }) => ({
    sessionId: "run",
    userId: run.owner_id,
    workspaceId: run.workspace_id,
  });

  async function load(ctx: RunContext): Promise<Loaded | null> {
    const { run } = ctx;
    if (!run.agent_version_id) return null;
    return asApp(deps.pool, principal(run), async (db) => {
      const { rows } = await db.query<{
        id: string;
        instructions: string;
        attachments: AgentAttachment[];
        sources: AgentSource[];
      }>("select id, instructions, attachments, sources from work.agent_version_for_run($1, $2)", [
        run.subject_id,
        run.agent_version_id,
      ]);
      const r = rows[0];
      return r
        ? {
            version_id: r.id,
            instructions: r.instructions,
            attachments: r.attachments,
            sources: r.sources,
          }
        : null;
    });
  }

  async function inputsOf(ctx: RunContext): Promise<string> {
    if (!ctx.run.thread_id) return "";
    return asApp(deps.pool, principal(ctx.run), async (db) => {
      const { rows } = await db.query<{ content: string }>(
        `select content from work.message where thread_id = $1 and role = 'user'
          order by id desc limit 1`,
        [ctx.run.thread_id],
      );
      return rows[0]?.content ?? "";
    });
  }

  async function answersSoFar(ctx: RunContext, before: number): Promise<string[]> {
    const { rows } = await asApp(deps.pool, principal(ctx.run), (db) =>
      db.query<{ output: { question?: { text: string }; answer?: unknown } }>(
        `select output from work.run_step where run_id = $1 and ordinal < $2 and output ? 'question'
          order by ordinal`,
        [ctx.run.id, before],
      ),
    );
    return rows.map((r) => {
      const a = r.output.answer as
        | { text?: string; option_id?: string; skip?: boolean }
        | undefined;
      const said = a?.skip
        ? "(skipped; proceed with reasonable assumptions)"
        : (a?.text ?? a?.option_id ?? "");
      return `Q: ${r.output.question?.text ?? ""}\nA: ${said}`;
    });
  }

  const step = (
    ctx: RunContext,
    s: StepRecord,
    title: string,
    status: "started" | "finished" | "failed" | "awaiting_user",
    extra: object = {},
  ) =>
    ctx.emit({
      type: "step",
      step_id: s.id,
      kind: s.kind === "retrieve" ? "retrieve" : s.kind === "ask_user" ? "ask_user" : "generate",
      status,
      title,
      ...extra,
    });

  const handler: RunHandler = {
    async plan(ctx) {
      const v = await load(ctx);
      if (!v)
        return { fail: { code: "NOT_FOUND", message: "That agent version isn't available." } };
      const who = { workspaceId: ctx.run.workspace_id, userId: ctx.run.owner_id };

      // Agents never pick a model; the class must have one the matter allows (§4.13).
      for (const cls of ["reason", "draft"] as const) {
        if (!(await policy.eligible(who, ctx.run.matter_id, cls))) {
          return {
            fail: {
              code: "MODEL_POLICY_NO_ELIGIBLE_MODEL",
              message: `No model is allowed for ${cls} work here.`,
            },
          };
        }
      }

      const usable: AgentAttachment[] = [];
      const leftOut: string[] = [];
      for (const a of v.attachments) {
        if (await deps.context.available(principal(ctx.run), a)) usable.push(a);
        else {
          leftOut.push(a.label);
          await deps.onWallDenied?.(who, ctx.run.id, a.label);
        }
      }
      if (v.attachments.length > 0 && usable.length === 0) {
        return {
          fail: {
            code: "WALL_NO_ACCESSIBLE_CONTEXT",
            message: "None of this agent's attachments are available to you.",
          },
        };
      }

      const steps = [
        ...(usable.length > 0
          ? [
              {
                id: "retrieve",
                title: "Read the attached material",
                sources: usable.map((a) => a.label),
                estimate: { docs: usable.length, pages: 0 },
              },
            ]
          : []),
        { id: "generate", title: "Do the work", sources: [], estimate: { docs: 0, pages: 0 } },
      ];
      const plan = {
        steps,
        estimated_cost_usd: { low: 0, high: 1 },
        editable: false,
        ...(leftOut.length > 0
          ? { not_read: leftOut.map((name) => ({ name, reason: "Not available to you" })) }
          : {}),
        usable,
        left_out: leftOut,
      } satisfies Record<string, unknown>;
      // Approval when the work is large: more than 10 steps, or more than 25 documents.
      const requiresApproval = steps.length > 10 || usable.length > 25;
      return { plan, requiresApproval };
    },

    async step(ctx, ordinal) {
      const stored = (ctx.run.plan ?? {}) as StoredPlan;
      const usable = stored.usable ?? [];
      const hasRetrieve = usable.length > 0;
      const who = { workspaceId: ctx.run.workspace_id, userId: ctx.run.owner_id };

      if (hasRetrieve && ordinal === 0) {
        const { step: s } = await ctx.store.beginStep({
          ordinal,
          kind: "retrieve",
          label: "Read the attached material",
        });
        await step(ctx, s, "Read the attached material", "started");
        let documents = 0;
        let pages = 0;
        for (const a of usable) {
          const m = await deps.context.read(who, a, contextChars);
          documents += m?.documents ?? 0;
          pages += m?.pages ?? 0;
        }
        const coverage = {
          documents_in_scope: documents,
          documents_read: documents,
          pages_read: pages,
          fraction: 1,
        };
        await ctx.store.finishStep(ordinal, {
          status: "done",
          output: { summary: `Read ${documents} document${documents === 1 ? "" : "s"}.`, coverage },
        });
        await ctx.emit({
          type: "coverage",
          coverage: {
            docs_in_scope: documents,
            docs_read: documents,
            pages_in_scope: pages,
            pages_read: pages,
            mode: "retrieval",
          },
        });
        await step(ctx, s, "Read the attached material", "finished");
        return { kind: "continue" };
      }

      const v = await load(ctx);
      if (!v)
        return { kind: "fail", code: "NOT_FOUND", message: "That agent version isn't available." };
      const inputs = await inputsOf(ctx);
      const qa = await answersSoFar(ctx, ordinal);
      const material: string[] = [];
      for (const a of usable) {
        const m = await deps.context.read(
          who,
          a,
          Math.floor(contextChars / Math.max(usable.length, 1)),
        );
        if (m)
          material.push(`<material label="@${a.label}" name="${m.name}">\n${m.text}\n</material>`);
      }
      const prompt = [
        `Instructions:\n${v.instructions}`,
        inputs ? `The person's inputs:\n${inputs}` : "",
        qa.length > 0 ? `Questions already asked:\n${qa.join("\n")}` : "",
        material.length > 0 ? material.join("\n\n") : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const messages: Message[] = [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ];

      const key = hash(`${ctx.run.id}:${ordinal}:${prompt}`);
      const { step: s, created } = await ctx.store.beginStep({
        ordinal,
        kind: "generate",
        label: "Do the work",
        idempotency_key: key,
      });
      void created;
      await step(ctx, s, "Do the work", "started");
      const messageId = randomUUID();
      try {
        const used = await ctx.store.totals();
        const result = await deps.gateway.call({
          task_class: TASK_CLASS.reason,
          messages,
          budget: { max_output: MAX_OUTPUT, max_cost_usd: Math.max(5 - used.cost_usd, 0.01) },
          routing: { workspace: ctx.run.workspace_id },
          trace: `${ctx.run.id}:${ordinal}`,
        });
        const text = result.output.trim();
        const model = result.model;
        const usage = {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
        };
        const asked = ASK.exec(text);
        if (asked) {
          let q: {
            question: string;
            options?: { id: string; label: string }[];
            allow_text?: boolean;
          };
          try {
            q = JSON.parse(asked[1] as string);
          } catch {
            q = { question: "Can you give a little more detail?" };
          }
          await ctx.store.finishStep(ordinal, {
            status: "awaiting_user",
            model,
            routing_class: "reason",
            usage,
            cost_usd: result.cost_usd,
            output: {
              summary: "Asked a question.",
              allow_skip: true,
              question: {
                text: q.question,
                options: q.options ?? [],
                allow_text: q.allow_text ?? true,
                allow_skip: true,
              },
            },
          });
          await ctx.emit({
            type: "question",
            step_id: s.id,
            question: {
              text: q.question,
              options: q.options ?? [],
              allow_text: q.allow_text ?? true,
              allow_skip: true,
            },
          });
          await step(ctx, s, "Asked a question", "awaiting_user");
          return { kind: "ask", step_id: s.id, allow_skip: true };
        }

        // A question looks like text until it ends, so the answer goes out once, whole.
        await ctx.emit({ type: "token", message_id: messageId, delta: text });
        await ctx.store.finishStep(ordinal, {
          status: "done",
          model,
          routing_class: "reason",
          usage,
          cost_usd: result.cost_usd,
          output: { summary: text.slice(0, 200), message_id: messageId },
        });
        await asApp(deps.pool, principal(ctx.run), async (db) => {
          await db.query(
            `insert into work.message (id, workspace_id, thread_id, role, content, model,
                                       input_tokens, output_tokens, tokens_estimated, cost_usd)
             values ($1, $2, $3, 'assistant', $4, $5, $6, $7, $8, $9)`,
            [
              messageId,
              ctx.run.workspace_id,
              ctx.run.thread_id,
              text,
              model,
              usage.input_tokens,
              usage.output_tokens,
              result.usage.estimated,
              result.cost_usd,
            ],
          );
          await db.query("update work.run set answer_id = $2, model = $3 where id = $1", [
            ctx.run.id,
            messageId,
            model,
          ]);
        });
        await step(ctx, s, "Do the work", "finished", { model, usage, cost_usd: result.cost_usd });
        await ctx.emit({ type: "output", kind: "message", message_id: messageId });
        return { kind: "done" };
      } catch (err) {
        const message = err instanceof Error ? err.message : "The model call failed.";
        const code =
          (err as { code?: string }).code === "BUDGET_EXCEEDED"
            ? "BUDGET_COST"
            : "MODEL_UNAVAILABLE";
        await ctx.store.finishStep(ordinal, {
          status: "failed",
          error: { code, message, retryable: code === "MODEL_UNAVAILABLE" },
        });
        await step(ctx, s, "Do the work", "failed");
        return { kind: "fail", code, message };
      }
    },

    async answer(ctx, s: StepRecord, answer) {
      await ctx.store.mergeOutput(s.ordinal, { answer });
    },

    async verify(ctx) {
      if (!deps.verifier) return { ok: true };
      const answer = await answerId(ctx);
      const { rows } = await asApp(deps.pool, principal(ctx.run), (db) =>
        db.query<{ content: string }>("select content from work.message where id = $1", [answer]),
      );
      return deps.verifier.verify(ctx, rows[0]?.content ?? "");
    },

    async ended(ctx, status) {
      if (status !== "done") return;
      const totals = await ctx.store.totals();
      const { rows } = await asApp(deps.pool, principal(ctx.run), (db) =>
        db.query<{ model: string | null; secs: number }>(
          "select model, extract(epoch from now() - created_at)::int as secs from work.run where id = $1",
          [ctx.run.id],
        ),
      );
      await ctx.emit({
        type: "done",
        message_id: await answerId(ctx),
        model: rows[0]?.model ?? null,
        response_mode: "auto",
        usage: { input_tokens: 0, output_tokens: Math.round(totals.tokens) },
        cost_usd: totals.cost_usd,
        citations: { total: 0, ok: 0, mismatch: 0, unresolved: 0, ungrounded_sentences: 0 },
        duration_ms: (rows[0]?.secs ?? 0) * 1000,
      });
    },
  };

  async function answerId(ctx: RunContext): Promise<string> {
    const { rows } = await asApp(deps.pool, principal(ctx.run), (db) =>
      db.query<{ answer_id: string | null }>("select answer_id from work.run where id = $1", [
        ctx.run.id,
      ]),
    );
    return rows[0]?.answer_id ?? "";
  }

  return handler;
}
