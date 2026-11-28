import type { Gateway, TaskClass } from "@legallabs/model-gateway";
import type pg from "pg";

const TASKS: readonly TaskClass[] = ["synthesize", "plan", "read_extract", "draft_edit"];

export interface MatterModels {
  /** Models the matter keeps its material from; every call about it leaves these out. */
  exclude: string[];
  /** False when the matter leaves no model for this kind of work. */
  allows(task: TaskClass): boolean;
}

/** What a matter's model policy leaves usable, read as the caller. */
export async function modelsFor(
  db: pg.PoolClient,
  gateway: Gateway,
  matterId: string | null,
): Promise<MatterModels> {
  const { rows } = matterId
    ? await db.query<{
        model_policy: { deny_providers?: string[]; deny_models?: string[] } | null;
      }>("select model_policy from core.matter where id = $1", [matterId])
    : { rows: [] };
  const policy = rows[0]?.model_policy;
  const denied = (id: string) => {
    const [provider = "", ...name] = id.split("/");
    return (
      policy?.deny_providers?.includes(provider) === true ||
      policy?.deny_models?.includes(id) === true ||
      policy?.deny_models?.includes(name.join("/")) === true
    );
  };
  const ids = (task: TaskClass) => gateway.models(task).map((m) => m.id);
  const exclude = [...new Set(TASKS.flatMap(ids))].filter(denied);
  return {
    exclude,
    // An install with no model at all is reported by the call itself, as unavailable.
    allows: (task) => ids(task).length === 0 || ids(task).some((id) => !denied(id)),
  };
}

export async function threadModels(db: pg.PoolClient, gateway: Gateway, threadId: string) {
  const { rows } = await db.query<{ matter_id: string | null }>(
    "select matter_id from work.thread where id = $1",
    [threadId],
  );
  return modelsFor(db, gateway, rows[0]?.matter_id ?? null);
}
