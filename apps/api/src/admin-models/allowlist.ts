import type { ModelConfig, ModelPolicy } from "@legallabs/contracts";

export interface Caller {
  userId: string;
  roleId: string | null;
}

export type Refusal = "MODEL_NOT_ALLOWED" | "NO_ALLOWED_MODEL";

/** Restrictions from a matter (SPC-006); narrower than the workspace, never wider. */
export interface MatterLimits {
  allowedModels?: readonly string[];
}

const keyOf = (m: Pick<ModelConfig, "provider" | "model">) => `${m.provider}/${m.model}`;

/**
 * Whether one model may be used by this caller: enabled, listed for their role or for them,
 * and inside the workspace policy and the matter's limits. Anything missing fails closed.
 */
export function modelAllowed(
  config: ModelConfig,
  caller: Caller,
  policy: ModelPolicy,
  matter?: MatterLimits,
): boolean {
  if (!config.enabled) return false;
  const listed =
    config.enabled_for_users.includes(caller.userId) ||
    (caller.roleId !== null && config.enabled_for_roles.includes(caller.roleId));
  if (!listed) return false;
  if (policy.zdr_only && !config.zdr) return false;
  if (policy.region_only !== null && config.region !== policy.region_only) return false;
  if (matter?.allowedModels && !matter.allowedModels.includes(keyOf(config))) return false;
  return true;
}

export function allowedModels(
  configs: readonly ModelConfig[],
  caller: Caller,
  policy: ModelPolicy,
  matter?: MatterLimits,
): ModelConfig[] {
  return configs.filter((c) => modelAllowed(c, caller, policy, matter));
}

/** Picks the model for a task class, or says why none could be: before any provider call. */
export function pickModel(
  configs: readonly ModelConfig[],
  caller: Caller,
  policy: ModelPolicy,
  taskClass: ModelConfig["task_class_default"][number],
  matter?: MatterLimits,
): { ok: true; model: ModelConfig } | { ok: false; reason: Refusal } {
  const pool = allowedModels(configs, caller, policy, matter).filter((c) =>
    c.capabilities.includes("chat"),
  );
  const chosen = pool.find((c) => c.task_class_default.includes(taskClass)) ?? pool[0];
  return chosen ? { ok: true, model: chosen } : { ok: false, reason: "NO_ALLOWED_MODEL" };
}

/** A user-picked model: refused with MODEL_NOT_ALLOWED when it is not in their allowed set. */
export function checkChoice(
  configs: readonly ModelConfig[],
  caller: Caller,
  policy: ModelPolicy,
  choice: { provider: string; model: string },
  matter?: MatterLimits,
): { ok: true; model: ModelConfig } | { ok: false; reason: Refusal } {
  const hit = allowedModels(configs, caller, policy, matter).find(
    (c) => keyOf(c) === keyOf(choice),
  );
  return hit ? { ok: true, model: hit } : { ok: false, reason: "MODEL_NOT_ALLOWED" };
}
