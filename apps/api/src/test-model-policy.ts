import { randomUUID } from "node:crypto";
import type { ModelProvider } from "@legallabs/model-gateway";
import type pg from "pg";

// Shared by the tests of a matter's model policy: a sealed matter, and two providers that
// count their calls, so a test can see which one was reached.

type Who = { workspaceId: string; userId: string };

export async function newMatter(pool: pg.Pool, who: Who): Promise<string> {
  const number = `M-${randomUUID().slice(0, 8)}`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name,
                              created_by)
     values ($1, 'C1', 'Acme', $2, 'Sealed', $3) returning id`,
    [who.workspaceId, number, who.userId],
  );
  return rows[0]?.id as string;
}

export const denyProviders = (pool: pg.Pool, matterId: string, ...providers: string[]) =>
  pool.query("update core.matter set model_policy = $2 where id = $1", [
    matterId,
    JSON.stringify({ deny_providers: providers, deny_models: [] }),
  ]);

export const fileInMatter = (pool: pg.Pool, versionId: string, matterId: string) =>
  pool.query(
    `update content.document set matter_id = $2
      where id = (select document_id from content.document_version where id = $1)`,
    [versionId, matterId],
  );

export function countingProviders(reply: (system: string, all: string) => string) {
  const calls = { anthropic: 0, ollama: 0 };
  const provider = (name: keyof typeof calls): ModelProvider => ({
    complete: async ({ messages }) => {
      calls[name]++;
      return {
        text: reply(messages[0]?.content ?? "", messages.map((m) => m.content).join("\n")),
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    },
  });
  return { calls, providers: { anthropic: provider("anthropic"), ollama: provider("ollama") } };
}
