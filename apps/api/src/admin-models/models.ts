import type {
  LocalEndpointInput,
  ModelConfig,
  ModelConfigPatch,
  ModelPolicy,
} from "@legallabs/contracts";
import { ROUTES } from "@legallabs/model-gateway";
import type pg from "pg";
import { audit } from "../auth/audit.js";
import type { Client, Principal } from "../auth/auth.js";
import { asApp, asWorker } from "../db.js";
import { type Caller, checkChoice, type MatterLimits } from "./allowlist.js";
import { type SecretBox, scrub } from "./secrets.js";

export type ModelFailure = "FORBIDDEN" | "NOT_FOUND" | "KEY_STORAGE_UNAVAILABLE" | "INVALID_REGION";
export type Result<T> = { ok: true; value: T } | { ok: false; reason: ModelFailure };

/** Sends one tiny request to prove an endpoint answers. Never throws; never echoes a key. */
export type EndpointTester = (
  endpoint: { url: string; model: string },
  key: string | null,
) => Promise<{ ok: boolean; message: string }>;

export const httpEndpointTester: EndpointTester = async ({ url, model }, key) => {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok
      ? { ok: true, message: "The endpoint answered." }
      : { ok: false, message: `The endpoint answered ${res.status}.` };
  } catch (err) {
    return {
      ok: false,
      message: scrub(`Could not reach the endpoint: ${(err as Error).message}`, key ? [key] : []),
    };
  }
};

export interface AdminModels {
  list(p: Principal): Promise<Result<{ items: ModelConfig[]; policy: ModelPolicy }>>;
  patch(
    p: Principal,
    provider: string,
    model: string,
    patch: ModelConfigPatch,
    client: Client,
  ): Promise<Result<ModelConfig>>;
  setKey(
    p: Principal,
    provider: string,
    model: string,
    key: string,
    client: Client,
  ): Promise<Result<ModelConfig>>;
  clearKey(
    p: Principal,
    provider: string,
    model: string,
    client: Client,
  ): Promise<Result<ModelConfig>>;
  addLocal(p: Principal, input: LocalEndpointInput, client: Client): Promise<Result<ModelConfig>>;
  test(
    p: Principal,
    provider: string,
    model: string,
  ): Promise<Result<{ ok: boolean; message: string }>>;
  setPolicy(p: Principal, policy: ModelPolicy, client: Client): Promise<Result<ModelPolicy>>;
  roles(p: Principal): Promise<Result<{ id: string; name: string }[]>>;
  /** What the caller may select. Empty selector list for roles without the selector. */
  allowedFor(p: Principal): Promise<{ items: ModelConfig[]; selector: boolean }>;
  /** Run start: refuses a chosen model the caller may not use (MODEL_NOT_ALLOWED). */
  checkChoice(
    p: Principal,
    choice: { provider: string; model: string },
    matter?: MatterLimits,
  ): Promise<{ ok: true } | { ok: false; reason: "MODEL_NOT_ALLOWED" }>;
  /** The key for a configured model, opened at call time for the gateway. Null if none. */
  keyFor(workspaceId: string, ref: string): Promise<string | null>;
}

interface Row {
  provider: string;
  model: string;
  enabled: boolean;
  enabled_for_roles: string[];
  enabled_for_users: string[];
  byok_secret_ref: string | null;
  endpoint_url: string | null;
  region: string;
  zdr: boolean;
  capabilities: ModelConfig["capabilities"];
  context_window: number | null;
  task_class_default: ModelConfig["task_class_default"];
}

const COLUMNS = `provider, model, enabled, enabled_for_roles, enabled_for_users, byok_secret_ref,
  endpoint_url, region, zdr, capabilities, context_window, task_class_default`;

const toConfig = (r: Row): ModelConfig => ({ ...r });

const DEFAULT_POLICY: ModelPolicy = {
  zdr_only: false,
  region_only: null,
  selector_disabled_roles: [],
};

/** Models the gateway knows, shown as switched off until an admin turns them on. */
function registryDefaults(): ModelConfig[] {
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
        zdr: r.client_data_safe,
        capabilities: ["chat"],
        context_window: r.context_window,
        task_class_default: [],
      });
    }
  }
  return [...seen.values()];
}

export function createAdminModels(
  pool: pg.Pool,
  options: { secrets?: SecretBox; tester?: EndpointTester } = {},
): AdminModels {
  const { secrets } = options;
  const tester = options.tester ?? httpEndpointTester;

  const isAdmin = async (db: pg.PoolClient) =>
    (await db.query<{ a: boolean }>("select core.has_permission('admin.config') a")).rows[0]?.a ===
    true;

  const readPolicy = async (db: pg.PoolClient, p: Principal): Promise<ModelPolicy> => {
    const { rows } = await db.query<ModelPolicy>(
      "select zdr_only, region_only, selector_disabled_roles from admin.model_policy where workspace_id = $1",
      [p.workspaceId],
    );
    return rows[0] ?? DEFAULT_POLICY;
  };

  const readAll = async (db: pg.PoolClient, p: Principal): Promise<ModelConfig[]> => {
    const { rows } = await db.query<Row>(
      `select ${COLUMNS} from admin.model_config where workspace_id = $1 order by provider, model`,
      [p.workspaceId],
    );
    const stored = rows.map(toConfig);
    const have = new Set(stored.map((m) => `${m.provider}/${m.model}`));
    return [...stored, ...registryDefaults().filter((m) => !have.has(`${m.provider}/${m.model}`))];
  };

  /** Ensures a row exists (from the registry defaults) so an edit can apply to it. */
  const ensure = async (db: pg.PoolClient, p: Principal, provider: string, model: string) => {
    const base = registryDefaults().find((m) => m.provider === provider && m.model === model);
    await db.query(
      `insert into admin.model_config (workspace_id, provider, model, region, zdr, capabilities, context_window)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing`,
      [
        p.workspaceId,
        provider,
        model,
        base?.region ?? "unspecified",
        base?.zdr ?? false,
        base?.capabilities ?? ["chat"],
        base?.context_window ?? null,
      ],
    );
  };

  const one = async (db: pg.PoolClient, p: Principal, provider: string, model: string) =>
    (
      await db.query<Row>(
        `select ${COLUMNS} from admin.model_config where workspace_id = $1 and provider = $2 and model = $3`,
        [p.workspaceId, provider, model],
      )
    ).rows[0];

  const known = (provider: string, model: string, rows: Row | undefined) =>
    rows !== undefined ||
    registryDefaults().some((m) => m.provider === provider && m.model === model);

  return {
    list: (p) =>
      asApp(pool, p, async (db) => {
        if (!(await isAdmin(db))) return { ok: false, reason: "FORBIDDEN" } as const;
        return {
          ok: true,
          value: { items: await readAll(db, p), policy: await readPolicy(db, p) },
        } as const;
      }),

    patch: (p, provider, model, patch, client) =>
      asApp(pool, p, async (db) => {
        if (!(await isAdmin(db))) return { ok: false, reason: "FORBIDDEN" } as const;
        if (!known(provider, model, await one(db, p, provider, model)))
          return { ok: false, reason: "NOT_FOUND" } as const;
        await ensure(db, p, provider, model);
        const sets: string[] = [];
        const args: unknown[] = [p.workspaceId, provider, model];
        for (const [col, value] of Object.entries(patch)) {
          if (value === undefined) continue;
          args.push(value);
          sets.push(`${col} = $${args.length}`);
        }
        if (sets.length > 0) {
          try {
            await db.query(
              `update admin.model_config set ${sets.join(", ")}, updated_at = now()
                where workspace_id = $1 and provider = $2 and model = $3`,
              args,
            );
          } catch (err) {
            if ((err as { code?: string }).code === "23514")
              return { ok: false, reason: "INVALID_REGION" } as const;
            throw err;
          }
        }
        await audit(db, p, client, "models.config_changed", "model", `${provider}/${model}`, {
          fields: Object.keys(patch),
        });
        const row = await one(db, p, provider, model);
        return row
          ? ({ ok: true, value: toConfig(row) } as const)
          : ({ ok: false, reason: "NOT_FOUND" } as const);
      }),

    setKey: (p, provider, model, key, client) =>
      asApp(pool, p, async (db) => {
        if (!(await isAdmin(db))) return { ok: false, reason: "FORBIDDEN" } as const;
        if (!secrets) return { ok: false, reason: "KEY_STORAGE_UNAVAILABLE" } as const;
        if (!known(provider, model, await one(db, p, provider, model)))
          return { ok: false, reason: "NOT_FOUND" } as const;
        await ensure(db, p, provider, model);
        const ref = secrets.newRef();
        await db.query(
          "insert into admin.secret (id, workspace_id, ciphertext) values ($1, $2, $3)",
          [ref, p.workspaceId, secrets.seal(key)],
        );
        const old = (await one(db, p, provider, model))?.byok_secret_ref;
        await db.query(
          "update admin.model_config set byok_secret_ref = $4, updated_at = now() where workspace_id = $1 and provider = $2 and model = $3",
          [p.workspaceId, provider, model, ref],
        );
        if (old)
          await db.query("delete from admin.secret where id = $1 and workspace_id = $2", [
            old,
            p.workspaceId,
          ]);
        // The audit row names the reference, never the key.
        await audit(db, p, client, "models.key_set", "model", `${provider}/${model}`, {
          secret_ref: ref,
        });
        return { ok: true, value: toConfig((await one(db, p, provider, model)) as Row) } as const;
      }),

    clearKey: (p, provider, model, client) =>
      asApp(pool, p, async (db) => {
        if (!(await isAdmin(db))) return { ok: false, reason: "FORBIDDEN" } as const;
        const row = await one(db, p, provider, model);
        if (!row) return { ok: false, reason: "NOT_FOUND" } as const;
        await db.query(
          "update admin.model_config set byok_secret_ref = null, updated_at = now() where workspace_id = $1 and provider = $2 and model = $3",
          [p.workspaceId, provider, model],
        );
        if (row.byok_secret_ref)
          await db.query("delete from admin.secret where id = $1 and workspace_id = $2", [
            row.byok_secret_ref,
            p.workspaceId,
          ]);
        await audit(db, p, client, "models.key_removed", "model", `${provider}/${model}`, {});
        return { ok: true, value: toConfig((await one(db, p, provider, model)) as Row) } as const;
      }),

    addLocal: (p, input, client) =>
      asApp(pool, p, async (db) => {
        if (!(await isAdmin(db))) return { ok: false, reason: "FORBIDDEN" } as const;
        if (input.api_key && !secrets)
          return { ok: false, reason: "KEY_STORAGE_UNAVAILABLE" } as const;
        let ref: string | null = null;
        if (input.api_key && secrets) {
          ref = secrets.newRef();
          await db.query(
            "insert into admin.secret (id, workspace_id, ciphertext) values ($1, $2, $3)",
            [ref, p.workspaceId, secrets.seal(input.api_key)],
          );
        }
        // A local endpoint is region "local" and ZDR by definition.
        await db.query(
          `insert into admin.model_config
             (workspace_id, provider, model, enabled, endpoint_url, region, zdr, capabilities, context_window, byok_secret_ref)
           values ($1, 'local', $2, false, $3, 'local', true, $4, $5, $6)
           on conflict (workspace_id, provider, model) do update set endpoint_url = $3,
             capabilities = $4, context_window = $5, byok_secret_ref = coalesce($6, admin.model_config.byok_secret_ref), updated_at = now()`,
          [p.workspaceId, input.name, input.url, input.capabilities, input.context_window, ref],
        );
        await audit(db, p, client, "models.local_added", "model", `local/${input.name}`, {});
        return {
          ok: true,
          value: toConfig((await one(db, p, "local", input.name)) as Row),
        } as const;
      }),

    test: async (p, provider, model) => {
      const found = await asApp(pool, p, async (db) =>
        (await isAdmin(db)) ? ((await one(db, p, provider, model)) ?? null) : "forbidden",
      );
      if (found === "forbidden") return { ok: false, reason: "FORBIDDEN" } as const;
      if (!found?.endpoint_url) return { ok: false, reason: "NOT_FOUND" } as const;
      const key = found.byok_secret_ref ? await keyFor(found.byok_secret_ref, p.workspaceId) : null;
      return { ok: true, value: await tester({ url: found.endpoint_url, model }, key) } as const;
    },

    setPolicy: (p, policy, client) =>
      asApp(pool, p, async (db) => {
        if (!(await isAdmin(db))) return { ok: false, reason: "FORBIDDEN" } as const;
        await db.query(
          `insert into admin.model_policy (workspace_id, zdr_only, region_only, selector_disabled_roles)
           values ($1, $2, $3, $4)
           on conflict (workspace_id) do update set zdr_only = $2, region_only = $3,
             selector_disabled_roles = $4, updated_at = now()`,
          [p.workspaceId, policy.zdr_only, policy.region_only, policy.selector_disabled_roles],
        );
        await audit(db, p, client, "models.policy_changed", "workspace", p.workspaceId, {
          zdr_only: policy.zdr_only,
          region_only: policy.region_only,
        });
        return { ok: true, value: policy } as const;
      }),

    roles: (p) =>
      asApp(pool, p, async (db) => {
        if (!(await isAdmin(db))) return { ok: false, reason: "FORBIDDEN" } as const;
        const { rows } = await db.query<{ id: string; name: string }>(
          "select id, name from core.role where workspace_id = $1 order by name",
          [p.workspaceId],
        );
        return { ok: true, value: rows } as const;
      }),

    allowedFor: (p) => allowed(p),
    checkChoice: async (p, choice, matter) => {
      const { caller, configs, policy } = await load(p);
      const result = checkChoice(configs, caller, policy, choice, matter);
      return result.ok ? { ok: true } : { ok: false, reason: "MODEL_NOT_ALLOWED" };
    },
    keyFor: (workspaceId, ref) => keyFor(ref, workspaceId),
  };

  async function load(p: Principal) {
    return asApp(pool, p, async (db) => {
      const { rows } = await db.query<{ role_id: string | null }>(
        'select role_id from core."user" where id = $1 and workspace_id = $2',
        [p.userId, p.workspaceId],
      );
      return {
        caller: { userId: p.userId, roleId: rows[0]?.role_id ?? null } satisfies Caller,
        configs: await readAll(db, p),
        policy: await readPolicy(db, p),
      };
    });
  }

  async function allowed(p: Principal) {
    const { allowedModels } = await import("./allowlist.js");
    const { caller, configs, policy } = await load(p);
    const selector =
      caller.roleId === null || !policy.selector_disabled_roles.includes(caller.roleId);
    return { items: selector ? allowedModels(configs, caller, policy) : [], selector };
  }

  async function keyFor(ref: string, workspaceId: string): Promise<string | null> {
    if (!secrets) return null;
    const sealed = await asWorker(
      pool,
      async (db) =>
        (
          await db.query<{ s: Buffer | null }>("select admin.read_secret($1, $2) s", [
            workspaceId,
            ref,
          ])
        ).rows[0]?.s ?? null,
    );
    return sealed ? secrets.open(sealed) : null;
  }
}
