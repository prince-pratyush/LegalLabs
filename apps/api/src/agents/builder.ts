import { AGENT_LIMITS } from "@legallabs/contracts";
import type { Gateway } from "@legallabs/model-gateway";
import type { RunContext, RunHandler } from "@legallabs/runs";
import type pg from "pg";
import { z } from "zod";
import { asApp, newMessageId } from "../db.js";
import { modelsFor, NO_MODEL_MESSAGE } from "../matters/model-policy.js";
import type { Agents } from "./agents.js";

/** At most this many clarifying questions before the builder writes (§3.1). */
export const MAX_QUESTIONS = 5;

const BUILDER_SYSTEM = [
  "You help a legal professional build an agent: a saved set of instructions that a model follows each time it is run.",
  "Work out the inputs it expects, the outputs it should produce, the sources it should consult, the tone and format, and when to stop.",
  "Reply with exactly one of: a line `QUESTION: ` followed by JSON",
  '{"question": string, "options": [{"id": string, "label": string}], "allow_text": boolean} to ask one clarifying question,',
  "or the single word READY when you have enough.",
].join(" ");

const WRITE_SYSTEM = [
  "Write an agent from the outcome and answers given. Reply with JSON only:",
  '{"title": string, "description": string, "practice_areas": string[], "instructions": string, "suggested_attachments": string[]}.',
  "The instructions are markdown, name attachments as @label, say when to ask the user, and forbid inventing sources.",
].join(" ");

const REVISE_SYSTEM =
  "Revise the agent's instructions as asked. Reply with the full revised instructions only, as markdown, with no commentary.";

const Written = z.object({
  title: z.string().max(AGENT_LIMITS.title).optional(),
  description: z.string().max(AGENT_LIMITS.description).optional(),
  practice_areas: z.array(z.string().max(60)).max(AGENT_LIMITS.practiceAreas).optional(),
  instructions: z.string().min(1).max(AGENT_LIMITS.instructions),
  suggested_attachments: z.array(z.string().max(200)).max(20).optional(),
});

const QUESTION = /^QUESTION:\s*(\{[\s\S]*\})\s*$/;

export interface BuilderDeps {
  pool: pg.Pool;
  gateway: Gateway;
  agents: Agents;
}

/** Extracts a JSON object from model text, which may wrap it in a fence. */
export function firstJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function createBuilderHandler(deps: BuilderDeps): RunHandler {
  const principal = (run: { owner_id: string; workspace_id: string }) => ({
    sessionId: "run",
    userId: run.owner_id,
    workspaceId: run.workspace_id,
  });
  const client = { ip: null, userAgent: null };

  const call = async (
    ctx: RunContext,
    ordinal: number,
    system: string,
    user: string,
    cls: "synthesize" | "draft_edit",
    exclude: readonly string[],
  ) => {
    const used = await ctx.store.totals();
    return deps.gateway.call({
      task_class: cls,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      budget: { max_output: 4000, max_cost_usd: Math.max(2 - used.cost_usd, 0.01) },
      routing: { workspace: ctx.run.workspace_id },
      trace: `${ctx.run.id}:${ordinal}`,
      ...(exclude.length ? { exclude } : {}),
    });
  };

  const lastUserText = (ctx: RunContext) =>
    asApp(deps.pool, principal(ctx.run), async (db) => {
      const { rows } = await db.query<{ content: string }>(
        "select content from work.message where thread_id = $1 and role = 'user' order by id",
        [ctx.run.thread_id],
      );
      return { first: rows[0]?.content ?? "", last: rows[rows.length - 1]?.content ?? "" };
    });

  const answers = (ctx: RunContext) =>
    asApp(deps.pool, principal(ctx.run), async (db) => {
      const { rows } = await db.query<{
        output: {
          question?: { text: string };
          answer?: { text?: string; option_id?: string; skip?: boolean };
        };
      }>(
        "select output from work.run_step where run_id = $1 and kind = 'ask_user' order by ordinal",
        [ctx.run.id],
      );
      return rows.map((r) => ({
        q: r.output.question?.text ?? "",
        a: r.output.answer?.skip
          ? null
          : (r.output.answer?.text ?? r.output.answer?.option_id ?? ""),
      }));
    });

  async function say(ctx: RunContext, text: string): Promise<string> {
    const id = await asApp(deps.pool, principal(ctx.run), newMessageId);
    await asApp(deps.pool, principal(ctx.run), async (db) => {
      await db.query(
        `insert into work.message (id, workspace_id, thread_id, role, content) values ($1, $2, $3, 'assistant', $4)`,
        [id, ctx.run.workspace_id, ctx.run.thread_id, text],
      );
      await db.query("update work.run set answer_id = $2 where id = $1", [ctx.run.id, id]);
    });
    await ctx.emit({ type: "token", message_id: id, delta: text });
    await ctx.emit({ type: "output", kind: "message", message_id: id });
    return id;
  }

  async function currentContent(ctx: RunContext) {
    const p = principal(ctx.run);
    const agent = await deps.agents.get(p, ctx.run.subject_id);
    if (!agent) return null;
    const versions = (await deps.agents.versions(p, ctx.run.subject_id)) ?? [];
    const base = versions.find(
      (v) => v.id === (agent.agent.draft_version_id ?? agent.agent.live_version_id),
    );
    return { agent: agent.agent, base };
  }

  async function saveDraft(ctx: RunContext, instructions: string, via: "edit" | "request_changes") {
    const p = principal(ctx.run);
    const current = await currentContent(ctx);
    const saved = await deps.agents.saveVersion(
      p,
      ctx.run.subject_id,
      {
        instructions,
        attachments: current?.base?.attachments ?? [],
        sources: current?.base?.sources ?? [],
        promote: false,
      },
      client,
      via,
    );
    if (!saved.ok) return null;
    await ctx.emit({
      type: "draft_updated",
      agent_id: ctx.run.subject_id,
      draft_version_id: saved.version.id,
    });
    return saved.version;
  }

  async function finalize(
    ctx: RunContext,
    ordinal: number,
    outcome: string,
    qa: { q: string; a: string | null }[],
    exclude: readonly string[],
  ) {
    const { step } = await ctx.store.beginStep({
      ordinal,
      kind: "draft",
      label: "Write the agent",
    });
    const prompt = [
      `Outcome the person wants:\n${outcome}`,
      qa.length > 0
        ? `Answers:\n${qa.map((x) => `Q: ${x.q}\nA: ${x.a ?? "(skipped)"}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const r = await call(ctx, ordinal, WRITE_SYSTEM, prompt, "synthesize", exclude);
    const parsed = Written.safeParse(firstJson(r.output));
    // A model that ignores the format still gives the person its text to edit.
    const written = parsed.success
      ? parsed.data
      : { instructions: r.output.trim().slice(0, AGENT_LIMITS.instructions) || outcome };
    const saved = await saveDraft(ctx, written.instructions, "edit");
    if (parsed.success && (written as z.infer<typeof Written>).title) {
      const w = written as z.infer<typeof Written>;
      await deps.agents.patch(
        principal(ctx.run),
        ctx.run.subject_id,
        {
          ...(w.title ? { title: w.title } : {}),
          ...(w.description ? { description: w.description } : {}),
          ...(w.practice_areas ? { practice_areas: w.practice_areas } : {}),
        },
        client,
      );
    }
    await ctx.store.finishStep(ordinal, {
      status: saved ? "done" : "failed",
      model: r.model,
      routing_class: "reason",
      usage: r.usage,
      cost_usd: r.cost_usd,
      output: { summary: saved ? "Drafted the instructions." : "Could not save the draft." },
      ...(saved
        ? {}
        : {
            error: {
              code: "SAVE_FAILED",
              message: "The draft could not be saved.",
              retryable: false,
            },
          }),
    });
    void step;
    if (!saved)
      return {
        kind: "fail" as const,
        code: "SAVE_FAILED",
        message: "The draft could not be saved.",
      };
    const suggested = parsed.success
      ? (written as z.infer<typeof Written>).suggested_attachments
      : undefined;
    await say(
      ctx,
      `I've drafted your agent. Review the instructions on the right, then attach any files it needs${
        suggested?.length ? `: ${suggested.join(", ")}` : ""
      }.`,
    );
    return { kind: "done" as const };
  }

  return {
    async plan() {
      return {
        plan: {
          steps: [
            { id: "build", title: "Build the agent", sources: [], estimate: { docs: 0, pages: 0 } },
          ],
          estimated_cost_usd: { low: 0, high: 0.2 },
          editable: false,
        },
        requiresApproval: false,
      };
    },

    async step(ctx, ordinal) {
      // The thread may be a matter's, and everything asked of the model comes from it.
      const models = await asApp(deps.pool, principal(ctx.run), (db) =>
        modelsFor(db, deps.gateway, {
          matters: [ctx.run.matter_id],
          threads: [ctx.run.thread_id],
        }),
      );
      if (!models.allows(ctx.run.test_mode ? "draft_edit" : "synthesize")) {
        return { kind: "fail", code: "MODEL_POLICY_NO_ELIGIBLE_MODEL", message: NO_MODEL_MESSAGE };
      }
      const texts = await lastUserText(ctx);

      // Test mode: "Request changes" revises the instructions, with no questions.
      if (ctx.run.test_mode) {
        const current = await currentContent(ctx);
        const { step } = await ctx.store.beginStep({
          ordinal,
          kind: "draft",
          label: "Revise the instructions",
        });
        const r = await call(
          ctx,
          ordinal,
          REVISE_SYSTEM,
          `Current instructions:\n${current?.base?.instructions ?? ""}\n\nRequested change:\n${texts.last}`,
          "draft_edit",
          models.exclude,
        );
        const revised = r.output.trim().slice(0, AGENT_LIMITS.instructions);
        const saved = revised ? await saveDraft(ctx, revised, "request_changes") : null;
        await ctx.store.finishStep(ordinal, {
          status: saved ? "done" : "failed",
          model: r.model,
          routing_class: "draft",
          usage: r.usage,
          cost_usd: r.cost_usd,
          output: { summary: saved ? "Proposed changes." : "No changes were produced." },
        });
        void step;
        if (!saved)
          return { kind: "fail", code: "NO_CHANGES", message: "The model produced no revision." };
        await say(ctx, "I've proposed changes. Open the editor tab and choose View changes.");
        return { kind: "done" };
      }

      const qa = await answers(ctx);
      const skipped = qa.some((x) => x.a === null);
      if (qa.length >= MAX_QUESTIONS || skipped) {
        return finalize(ctx, ordinal, texts.first, qa, models.exclude);
      }

      const { step } = await ctx.store.beginStep({
        ordinal,
        kind: "ask_user",
        label: "Ask a question",
      });
      const r = await call(
        ctx,
        ordinal,
        BUILDER_SYSTEM,
        `Outcome:\n${texts.first}\n\nAnswers so far:\n${qa.map((x) => `Q: ${x.q}\nA: ${x.a ?? ""}`).join("\n") || "(none)"}`,
        "synthesize",
        models.exclude,
      );
      const asked = QUESTION.exec(r.output.trim());
      if (!asked) {
        // READY, or anything that isn't a question, means write now.
        await ctx.store.finishStep(ordinal, {
          status: "skipped",
          model: r.model,
          routing_class: "reason",
          usage: r.usage,
          cost_usd: r.cost_usd,
          output: { summary: "Ready to write." },
        });
        void step;
        return finalize(ctx, ordinal + 1, texts.first, qa, models.exclude);
      }
      let q: { question: string; options?: { id: string; label: string }[]; allow_text?: boolean };
      try {
        q = JSON.parse(asked[1] as string);
      } catch {
        return finalize(ctx, ordinal + 1, texts.first, qa, models.exclude);
      }
      const question = {
        text: q.question,
        options: q.options ?? [],
        allow_text: q.allow_text ?? true,
        allow_skip: true,
      };
      await ctx.store.finishStep(ordinal, {
        status: "awaiting_user",
        model: r.model,
        routing_class: "reason",
        usage: r.usage,
        cost_usd: r.cost_usd,
        output: { summary: "Asked a question.", allow_skip: true, question },
      });
      await ctx.emit({ type: "question", step_id: step.id, question });
      return { kind: "ask", step_id: step.id, allow_skip: true };
    },

    async answer(ctx, step, answer) {
      await ctx.store.mergeOutput(step.ordinal, { answer });
    },

    verify: async () => ({ ok: true }),
  };
}
