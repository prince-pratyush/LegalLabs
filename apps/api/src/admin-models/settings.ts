import type { ModelConfig, ModelPolicy } from "@legallabs/contracts";
import { ROUTES } from "@legallabs/model-gateway";
import { modelAllowed, withinPolicy } from "./allowlist.js";

// What a workspace's stored model settings leave usable. One rule, used by the gateway for
// every call and by the lists people see.

export const DEFAULT_POLICY: ModelPolicy = {
  zdr_only: false,
  region_only: null,
  selector_disabled_roles: [],
};

/** Models the gateway knows, shown as switched off until an admin turns them on. */
export function registryDefaults(): ModelConfig[] {
  const seen = new Map<string, ModelConfig>();
  for (const [taskClass, routes] of Object.entries(ROUTES)) {
    for (const r of routes) {
      const key = `${r.provider}/${r.model}`;
      const existing = seen.get(key);
      if (existing) {
        existing.task_class_default = [
          ...existing.task_class_default,
          taskClass as ModelConfig["task_class_default"][number],
        ];
        continue;
      }
      seen.set(key, {
        provider: r.provider,
        model: r.model,
        enabled: false,
        enabled_for_roles: [],
        enabled_for_users: [],
        byok_secret_ref: null,
        endpoint_url: null,
        region: r.provider === "ollama" ? "local" : "unspecified",
        // Zero retention is an agreement only the deployer can vouch for, except on their own machine.
        zdr: r.provider === "ollama",
        capabilities: ["chat"],
        context_window: r.context_window,
        task_class_default: [],
      });
    }
  }
  return [...seen.values()];
}

/** A workspace's stored settings, as admin.model_settings returns them. */
export interface StoredSettings {
  policy: ModelPolicy | null;
  models: ModelConfig[];
  role_id: string | null;
}

/** Stored models first, then every other model the gateway knows. */
export function withDefaults(stored: readonly ModelConfig[]): ModelConfig[] {
  const have = new Set(stored.map((m) => `${m.provider}/${m.model}`));
  return [...stored, ...registryDefaults().filter((m) => !have.has(`${m.provider}/${m.model}`))];
}

/**
 * The models a person (or, with no user, the workspace's own work) may use. The allow-list is in
 * force once an admin has configured any model; until then only the workspace policy narrows.
 */
export function usableModels(settings: StoredSettings, userId: string | null): ModelConfig[] {
  const policy = settings.policy ?? DEFAULT_POLICY;
  const caller = userId === null ? null : { userId, roleId: settings.role_id };
  const allowList = settings.models.length > 0;
  return withDefaults(settings.models).filter(
    (m) =>
      m.capabilities.includes("chat") &&
      (allowList ? modelAllowed(m, caller, policy) : withinPolicy(m, policy)),
  );
}

export function workspaceRule(settings: StoredSettings, userId: string | null) {
  const ids = new Set(usableModels(settings, userId).map((m) => `${m.provider}/${m.model}`));
  return { permits: (id: string) => ids.has(id) };
}
