import { createHash } from "node:crypto";
import { normalizeMemoryText, STYLE_LIMITS } from "@legallabs/contracts";
import type pg from "pg";
import { audit } from "../auth/audit.js";
import type { Client, Principal } from "../auth/auth.js";
import { asApp } from "../db.js";
import type { Memories } from "./memory.js";
import {
  buildGuidance,
  detectRemember,
  extractCandidates,
  type HeldMemory,
  INFER_INSTRUCTION,
  type StyleForPrompt,
  selectMemories,
} from "./prompt.js";

/** What one turn's personalisation decided, carried from the prompt to the saved answer. */
export interface TurnPlan {
  /** System text for the model, or null when there is nothing to add. */
  guidance: string | null;
  used: string[];
  notApplied: string[];
  /** Memories made from "remember that ..." in this message. */
  created: string[];
  styleId: string | null;
  inferCandidates: boolean;
}

export interface TurnInput {
  question: string;
  /** The composer's per-thread override; left out, the person's own setting decides. */
  useMemory?: boolean | undefined;
  writingStyleId?: string | null | undefined;
}

/**
 * How the thread service asks for personalisation. Optional everywhere: without it a thread
 * answers exactly as before. It never throws, so a fault here can't stop an answer.
 */
export interface Personalisation {
  prepare(principal: Principal, input: TurnInput, client: Client): Promise<TurnPlan | null>;
  /** Takes candidate blocks off the answer text, so they are never saved or shown. */
  split(plan: TurnPlan | null, text: string): { text: string; candidates: string[] };
  /** Records what shaped the saved answer, for its author only. */
  finish(
    principal: Principal,
    messageId: string,
    plan: TurnPlan | null,
    candidates: readonly string[],
  ): Promise<void>;
}

export const noPersonalisation: Personalisation = {
  prepare: async () => null,
  split: (_plan, text) => ({ text, candidates: [] }),
  finish: async () => {},
};

interface MemoryRow {
  id: string;
  text: string;
  created_at: Date;
}

export function createPersonalisation(
  pool: pg.Pool,
  memories: Pick<Memories, "propose">,
  options: { infer?: boolean } = {},
): Personalisation {
  const infer = options.infer === true;

  async function styleFor(
    db: pg.PoolClient,
    userId: string,
    id: string | null | undefined,
  ): Promise<StyleForPrompt | null> {
    if (!id) return null;
    const { rows } = await db.query<{
      owner_id: string;
      kind: "instructions" | "sample";
      instructions: string | null;
      derived_instructions: string | null;
      sample_text: string | null;
      status: string;
    }>(
      `select owner_id, kind, instructions, derived_instructions, sample_text, status
         from memory.writing_style where id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    const owner = row.owner_id === userId;
    // A colleague's sample is never quoted: only the instructions drawn from it are used.
    const text = owner
      ? (row.derived_instructions ?? row.instructions)
      : row.kind === "sample"
        ? row.derived_instructions
        : row.instructions;
    if (!text) return null;
    return {
      id,
      instructions: text,
      shared: !owner,
      excerpt:
        owner && row.kind === "sample" && row.sample_text
          ? row.sample_text.slice(0, STYLE_LIMITS.excerptChars)
          : null,
    };
  }

  return {
    async prepare(p, input, client) {
      try {
        return await asApp(pool, p, async (db) => {
          const access = await db.query<{ ok: boolean }>(
            "select core.has_permission('memory.use') and memory.is_member() as ok",
          );
          const permitted = access.rows[0]?.ok === true;
          const member = await db.query<{ ok: boolean }>("select memory.is_member() as ok");
          const style = member.rows[0]?.ok ? await styleFor(db, p.userId, input.writingStyleId) : null;

          // "Remember that ..." makes a memory now, so this very answer can follow it.
          const created: { id: string; text: string }[] = [];
          if (permitted) {
            const asked = detectRemember(input.question);
            for (const text of asked.texts) {
              const hash = createHash("sha256").update(normalizeMemoryText(text)).digest("hex");
              const made = await db.query<{ id: string }>(
                `insert into memory.memory (workspace_id, user_id, text, source, normalized_hash)
                 values ($1, $2, $3, 'asked', $4) on conflict (user_id, normalized_hash) do nothing
                 returning id`,
                [p.workspaceId, p.userId, text, hash],
              );
              const row = made.rows[0];
              if (!row) continue;
              created.push({ id: row.id, text });
              await audit(db, p, client, "memory.created", "memory", row.id, { source: "asked" });
            }
          }

          let held: HeldMemory[] = [];
          let on = false;
          if (permitted) {
            const setting = await db.query<{ use_memory: boolean }>(
              "select use_memory from memory.memory_setting where user_id = core.current_user_id()",
            );
            on = input.useMemory ?? setting.rows[0]?.use_memory ?? true;
            if (on) {
              const { rows } = await db.query<MemoryRow>(
                "select id, text, created_at from memory.memory order by created_at desc, id desc",
              );
              held = rows.map((r) => ({ id: r.id, text: r.text, createdAt: r.created_at }));
            }
          }
          const chosen = selectMemories(held, input.question, style);
          const base = buildGuidance(style, chosen.used);
          const guidance =
            infer && permitted && on
              ? `${base ?? "Personalisation follows."}\n\n${INFER_INSTRUCTION}`
              : base;
          return {
            guidance,
            used: chosen.used.map((m) => m.id),
            notApplied: chosen.notApplied.map((m) => m.id),
            created: created.map((m) => m.id),
            styleId: style?.id ?? null,
            // With memory off nothing is proposed from the conversation either.
            inferCandidates: infer && permitted && on,
          };
        });
      } catch (err) {
        console.error(`personalisation failed: ${err instanceof Error ? err.name : "unknown"}`);
        return null;
      }
    },

    split(plan, text) {
      return plan?.inferCandidates ? extractCandidates(text) : { text, candidates: [] };
    },

    async finish(p, messageId, plan, candidates) {
      if (!plan) return;
      try {
        const worth =
          plan.used.length > 0 ||
          plan.notApplied.length > 0 ||
          plan.created.length > 0 ||
          plan.styleId !== null;
        if (worth) {
          await asApp(pool, p, (db) =>
            db.query(
              `insert into memory.message_use
                 (message_id, workspace_id, user_id, memory_ids, not_applied, created_ids,
                  writing_style_id)
               values ($1, $2, $3, $4, $5, $6, $7) on conflict (message_id) do nothing`,
              [
                messageId,
                p.workspaceId,
                p.userId,
                plan.used,
                plan.notApplied,
                plan.created,
                plan.styleId,
              ],
            ),
          );
        }
        if (candidates.length > 0) await memories.propose(p, messageId, candidates);
      } catch (err) {
        console.error(
          `personalisation record failed: ${err instanceof Error ? err.name : "unknown"}`,
        );
      }
    },
  };
}
