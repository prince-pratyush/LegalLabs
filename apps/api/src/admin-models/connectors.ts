import type {
  Connector,
  ConnectorInput,
  DiscoverResult,
  ManifestDiff,
  ToolPolicy,
} from "@legallabs/contracts";
import type pg from "pg";
import { audit } from "../auth/audit.js";
import type { Client, Principal } from "../auth/auth.js";
import { createPolicyEngine, type PolicyDecision } from "../connectors/policy.js";
import { asApp, asWorker } from "../db.js";
import {
  type DiscoveryAuth,
  type McpDiscovery,
  manifestHash,
  type RawTool,
  safeConnectorUrl,
  toolHash,
  uniqueTools,
} from "./discovery.js";
import type { SecretBox } from "./secrets.js";

export type ConnectorFailure =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_URL"
  | "DUPLICATE_NAME"
  | "DISCOVERY_FAILED"
  | "NO_TOOLS_DISCOVERED"
  | "NO_TOOL_ALLOWED"
  | "KEY_STORAGE_UNAVAILABLE"
  | "POLICY_TIGHTEN_ONLY";
export type Result<T> = { ok: true; value: T } | { ok: false; reason: ConnectorFailure };

export interface CallContext {
  connectorId: string;
  toolName: string;
  surface: "interactive" | "scheduled";
  /** Prior calls to this tool in the run. */
  callsToToolInRun: number;
  /** Hash of the manifest the server presented this session; absent counts as a mismatch. */
  observedManifestHash: string | undefined;
  matterBlocksConnector?: boolean;
}

/** A tool a run may be told about; what it may do with it is decided per call. */
export interface OfferedTool {
  /** What the model writes to call it: "connector.tool". */
  name: string;
  connectorId: string;
  connectorName: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Where a tool call goes, and what was pinned when an admin approved it. */
export interface ConnectorEndpoint {
  url: string;
  auth: DiscoveryAuth;
  manifestHash: string;
  toolHash: string;
}

export interface AdminConnectors {
  /**
   * The tools of the named connectors (by id or name) this person may be offered: the connector
   * must be enabled and the tool not blocked for them. Empty without `connectors.use`.
   */
  offered(
    p: Principal,
    scopes: readonly { connector: string; tools?: readonly string[] }[],
  ): Promise<OfferedTool[]>;
  /** Null when the connector isn't enabled, the person may not use it, or its key can't be read. */
  endpoint(p: Principal, connectorId: string, toolName: string): Promise<ConnectorEndpoint | null>;
  /** Shuts a connector whose live manifest no longer matches the pin, until an admin re-approves. */
  reportDrift(p: Principal, connectorId: string, client: Client): Promise<void>;
  list(p: Principal): Promise<Connector[]>;
  register(p: Principal, input: ConnectorInput, client: Client): Promise<Result<Connector>>;
  discover(p: Principal, id: string, client: Client): Promise<Result<DiscoverResult>>;
  setToolPolicy(
    p: Principal,
    id: string,
    tool: string,
    policy: ToolPolicy,
    client: Client,
  ): Promise<Result<Connector>>;
  approve(p: Principal, id: string, client: Client): Promise<Result<Connector>>;
  disable(p: Principal, id: string, client: Client): Promise<Result<Connector>>;
  setUserPolicy(
    p: Principal,
    id: string,
    tool: string,
    policy: "ask_user" | "block",
    client: Client,
  ): Promise<Result<Connector>>;
  /** The decision for one tool call. Never throws: any failure is `block`. */
  decide(p: Principal, call: CallContext, client: Client): Promise<PolicyDecision>;
}

interface ConnRow {
  id: string;
  name: string;
  url: string;
  auth_kind: Connector["auth_kind"];
  secret_ref: string | null;
  trust_tier: Connector["trust_tier"];
  status: Connector["status"];
  manifest_hash: string | null;
  disabled_reason: string | null;
  created_at: Date;
}
interface ToolRow {
  connector_id: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  tool_hash: string;
  policy: ToolPolicy;
}

const BADGES: Record<Connector["trust_tier"], string> = {
  first_party: "First party",
  vendor: "Vendor",
  community: "Community",
  custom: "Custom — not reviewed",
};

// MCP's own default is that a tool may write: readOnlyHint is false unless the server says
// otherwise. A server that leaves the annotation out is not vouching for the tool, so only an
// explicit readOnlyHint: true counts as a read.
const WRITE_HINT = (a: Record<string, unknown>) =>
  a.readOnlyHint !== true || a.destructiveHint === true;

export function createAdminConnectors(
  pool: pg.Pool,
  options: { secrets?: SecretBox; discovery: McpDiscovery },
): AdminConnectors {
  const { secrets, discovery } = options;

  const isAdmin = async (db: pg.PoolClient) =>
    (await db.query<{ a: boolean }>("select core.has_permission('admin.config') a")).rows[0]?.a ===
    true;

  const view = async (db: pg.PoolClient, p: Principal, id: string): Promise<Connector | null> => {
    const c = (
      await db.query<ConnRow>("select * from admin.connector where id = $1 and workspace_id = $2", [
        id,
        p.workspaceId,
      ])
    ).rows[0];
    if (!c) return null;
    const tools = (
      await db.query<ToolRow>(
        "select * from admin.connector_tool where connector_id = $1 order by name",
        [id],
      )
    ).rows;
    const mine = new Map(
      (
        await db.query<{ tool_name: string; policy: ToolPolicy }>(
          "select tool_name, policy from admin.connector_user_policy where connector_id = $1 and user_id = $2",
          [id, p.userId],
        )
      ).rows.map((r) => [r.tool_name, r.policy]),
    );
    return {
      id: c.id,
      name: c.name,
      url: c.url,
      auth_kind: c.auth_kind,
      trust_tier: c.trust_tier,
      badge: BADGES[c.trust_tier],
      status: c.status,
      manifest_hash: c.manifest_hash,
      disabled_reason: c.disabled_reason,
      created_at: c.created_at.toISOString(),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
        annotations: t.annotations,
        policy: t.policy,
        user_policy: mine.get(t.name) ?? null,
      })),
    };
  };

  // Sealed bytes are readable only through the worker's function, never by the app role.
  const authFor = async (c: ConnRow, workspaceId: string): Promise<DiscoveryAuth | null> => {
    if (c.auth_kind !== "bearer") return { kind: "none" };
    if (!secrets || !c.secret_ref) return null;
    const ref = c.secret_ref;
    const sealed = await asWorker(
      pool,
      async (w) =>
        (
          await w.query<{ s: Buffer | null }>("select admin.read_secret($1, $2) s", [
            workspaceId,
            ref,
          ])
        ).rows[0]?.s ?? null,
    );
    return sealed ? { kind: "bearer", token: secrets.open(sealed) } : null;
  };

  const mayUse = async (db: pg.PoolClient) =>
    (await db.query<{ a: boolean }>("select core.has_permission('connectors.use') a")).rows[0]
      ?.a === true;

  const diffOf = (old: ToolRow[], fresh: Map<string, string>): ManifestDiff => {
    const before = new Map(old.map((t) => [t.name, t.tool_hash]));
    return {
      added: [...fresh.keys()].filter((n) => !before.has(n)).sort(),
      removed: [...before.keys()].filter((n) => !fresh.has(n)).sort(),
      changed: [...fresh.keys()]
        .filter((n) => before.has(n) && before.get(n) !== fresh.get(n))
        .sort(),
    };
  };

  /** Writes a fresh manifest: unchanged tools keep their policy, new or changed ones are blocked. */
  const apply = async (db: pg.PoolClient, p: Principal, c: ConnRow, tools: RawTool[]) => {
    const old = new Map(
      (
        await db.query<ToolRow>("select * from admin.connector_tool where connector_id = $1", [
          c.id,
        ])
      ).rows.map((t) => [t.name, t]),
    );
    await db.query("delete from admin.connector_tool where connector_id = $1", [c.id]);
    const hashes: string[] = [];
    for (const t of tools) {
      const h = toolHash(t);
      hashes.push(h);
      const keep = old.get(t.name)?.tool_hash === h ? old.get(t.name)?.policy : undefined;
      await db.query(
        `insert into admin.connector_tool (workspace_id, connector_id, name, description, input_schema, annotations, tool_hash, policy)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          p.workspaceId,
          c.id,
          t.name,
          t.description,
          JSON.stringify(t.input_schema),
          JSON.stringify(t.annotations),
          h,
          keep ?? "block",
        ],
      );
    }
    return manifestHash(hashes);
  };

  const loadConn = async (db: pg.PoolClient, p: Principal, id: string) =>
    (
      await db.query<ConnRow>(
        "select * from admin.connector where id = $1 and workspace_id = $2 for update",
        [id, p.workspaceId],
      )
    ).rows[0];

  async function discoverIn(
    db: pg.PoolClient,
    p: Principal,
    c: ConnRow,
    client: Client,
    acceptDrift: boolean,
  ): Promise<Result<DiscoverResult>> {
    const auth = await authFor(c, p.workspaceId);
    if (!auth || !safeConnectorUrl(c.url)) return { ok: false, reason: "DISCOVERY_FAILED" };
    let tools: RawTool[];
    try {
      tools = await discovery(c.url, auth);
    } catch {
      return { ok: false, reason: "DISCOVERY_FAILED" };
    }
    tools = uniqueTools(tools);
    const fresh = new Map(tools.map((t) => [t.name, toolHash(t)]));
    const hash = manifestHash([...fresh.values()]);
    const old = (
      await db.query<ToolRow>("select * from admin.connector_tool where connector_id = $1", [c.id])
    ).rows;

    let diff: ManifestDiff | null = null;
    const pinned = c.manifest_hash;
    const drifted = pinned !== null && pinned !== hash;
    if (drifted && c.status !== "pending_approval" && !acceptDrift) {
      // Keep the old pin and tools; shut the connector until an admin looks at the diff.
      diff = diffOf(old, fresh);
      await db.query(
        "update admin.connector set status = 'disabled', disabled_reason = 'CONNECTOR_MANIFEST_CHANGED', updated_at = now() where id = $1",
        [c.id],
      );
      await audit(db, p, client, "connector.schema_drift", "connector", c.id, {
        added: diff.added.length,
        removed: diff.removed.length,
        changed: diff.changed.length,
      });
    } else {
      if (drifted) diff = diffOf(old, fresh);
      const newHash = await apply(db, p, c, tools);
      await db.query(
        "update admin.connector set manifest_hash = $2, updated_at = now() where id = $1",
        [c.id, newHash],
      );
      await audit(db, p, client, "connector.discovered", "connector", c.id, {
        tools: tools.length,
      });
    }
    const connector = (await view(db, p, c.id)) as Connector;
    return { ok: true, value: { connector, diff } };
  }

  return {
    offered: (p, scopes) =>
      asApp(pool, p, async (db) => {
        if (scopes.length === 0 || !(await mayUse(db))) return [];
        const out: OfferedTool[] = [];
        for (const scope of scopes) {
          const { rows } = await db.query<ToolRow & { connector_name: string }>(
            `select t.*, c.name as connector_name
               from admin.connector c
               join admin.connector_tool t on t.connector_id = c.id
               left join admin.connector_user_policy u
                 on u.connector_id = c.id and u.user_id = $3 and u.tool_name = t.name
              where c.workspace_id = $2 and (c.id::text = $1 or c.name = $1)
                and c.status = 'enabled' and t.policy <> 'block'
                and u.policy is distinct from 'block'
              order by t.name`,
            [scope.connector, p.workspaceId, p.userId],
          );
          for (const t of rows) {
            if (scope.tools && !scope.tools.includes(t.name)) continue;
            const name = `${t.connector_name}.${t.name}`;
            if (out.some((o) => o.name === name)) continue;
            out.push({
              name,
              connectorId: t.connector_id,
              connectorName: t.connector_name,
              tool: t.name,
              description: t.description,
              inputSchema: t.input_schema,
            });
          }
        }
        return out;
      }),

    endpoint: async (p, id, toolName) => {
      const found = await asApp(pool, p, async (db) => {
        if (!(await mayUse(db))) return null;
        const c = (
          await db.query<ConnRow>(
            "select * from admin.connector where id = $1 and workspace_id = $2 and status = 'enabled'",
            [id, p.workspaceId],
          )
        ).rows[0];
        const t = (
          await db.query<ToolRow>(
            "select * from admin.connector_tool where connector_id = $1 and name = $2",
            [id, toolName],
          )
        ).rows[0];
        return c && t ? { c, t } : null;
      });
      if (!found?.c.manifest_hash || !safeConnectorUrl(found.c.url)) return null;
      const auth = await authFor(found.c, p.workspaceId);
      return auth
        ? {
            url: found.c.url,
            auth,
            manifestHash: found.c.manifest_hash,
            toolHash: found.t.tool_hash,
          }
        : null;
    },

    reportDrift: async (p, id, client) => {
      // A member can't write connectors, so the worker's one function does the shutting.
      const shut = await asWorker(
        pool,
        async (w) =>
          (
            await w.query<{ shut: boolean }>("select admin.report_connector_drift($1, $2) shut", [
              p.workspaceId,
              id,
            ])
          ).rows[0]?.shut === true,
      );
      if (shut) {
        await asApp(pool, p, (db) =>
          audit(db, p, client, "connector.schema_drift", "connector", id, { seen: "tool_call" }),
        );
      }
    },

    list: (p) =>
      asApp(pool, p, async (db) => {
        const admin = await isAdmin(db);
        const { rows } = await db.query<{ id: string }>(
          `select id from admin.connector where workspace_id = $1 ${admin ? "" : "and status = 'enabled'"} order by name`,
          [p.workspaceId],
        );
        const out: Connector[] = [];
        for (const r of rows) {
          const v = await view(db, p, r.id);
          if (v) out.push(v);
        }
        return out;
      }),

    register: (p, input, client) =>
      asApp(pool, p, async (db) => {
        if (!(await isAdmin(db))) return { ok: false, reason: "FORBIDDEN" } as const;
        if (!safeConnectorUrl(input.url)) return { ok: false, reason: "INVALID_URL" } as const;
        const secretValue =
          input.auth.kind === "bearer"
            ? input.auth.token
            : input.auth.kind === "oauth_client"
              ? JSON.stringify({ id: input.auth.client_id, secret: input.auth.client_secret })
              : null;
        if (secretValue !== null && !secrets)
          return { ok: false, reason: "KEY_STORAGE_UNAVAILABLE" } as const;
        let ref: string | null = null;
        if (secretValue !== null && secrets) {
          ref = secrets.newRef();
          await db.query(
            "insert into admin.secret (id, workspace_id, ciphertext) values ($1, $2, $3)",
            [ref, p.workspaceId, secrets.seal(secretValue)],
          );
        }
        try {
          const { rows } = await db.query<{ id: string }>(
            `insert into admin.connector (workspace_id, name, url, auth_kind, secret_ref)
             values ($1, $2, $3, $4, $5) returning id`,
            [p.workspaceId, input.name, input.url, input.auth.kind, ref],
          );
          const id = rows[0]?.id as string;
          await audit(db, p, client, "connector.registered", "connector", id, {
            trust_tier: "custom",
          });
          return { ok: true, value: (await view(db, p, id)) as Connector } as const;
        } catch (err) {
          if ((err as { code?: string }).code === "23505")
            return { ok: false, reason: "DUPLICATE_NAME" } as const;
          throw err;
        }
      }),

    discover: (p, id, client) =>
      asApp(pool, p, async (db) => {
        if (!(await isAdmin(db))) return { ok: false, reason: "FORBIDDEN" } as const;
        const c = await loadConn(db, p, id);
        if (!c) return { ok: false, reason: "NOT_FOUND" } as const;
        return discoverIn(db, p, c, client, false);
      }),

    setToolPolicy: (p, id, tool, policy, client) =>
      asApp(pool, p, async (db) => {
        if (!(await isAdmin(db))) return { ok: false, reason: "FORBIDDEN" } as const;
        const { rowCount } = await db.query(
          "update admin.connector_tool set policy = $3 where connector_id = $1 and name = $2 and workspace_id = $4",
          [id, tool, policy, p.workspaceId],
        );
        if (!rowCount) return { ok: false, reason: "NOT_FOUND" } as const;
        await audit(db, p, client, "connector.policy_changed", "connector", id, { tool, policy });
        return { ok: true, value: (await view(db, p, id)) as Connector } as const;
      }),

    approve: (p, id, client) =>
      asApp(pool, p, async (db) => {
        if (!(await isAdmin(db))) return { ok: false, reason: "FORBIDDEN" } as const;
        const c = await loadConn(db, p, id);
        if (!c) return { ok: false, reason: "NOT_FOUND" } as const;
        // Re-approving after drift re-reads the server and pins what it says now; changed and
        // new tools come back blocked, so the admin must set them again on purpose.
        if (c.disabled_reason === "CONNECTOR_MANIFEST_CHANGED") {
          const again = await discoverIn(db, p, c, client, true);
          if (!again.ok) return again;
        }
        const tools = (
          await db.query<ToolRow>("select * from admin.connector_tool where connector_id = $1", [
            id,
          ])
        ).rows;
        if (tools.length === 0) return { ok: false, reason: "NO_TOOLS_DISCOVERED" } as const;
        if (!tools.some((t) => t.policy !== "block"))
          return { ok: false, reason: "NO_TOOL_ALLOWED" } as const;
        await db.query(
          "update admin.connector set status = 'enabled', disabled_reason = null, updated_at = now() where id = $1",
          [id],
        );
        await audit(db, p, client, "connector.approved", "connector", id, { tools: tools.length });
        return { ok: true, value: (await view(db, p, id)) as Connector } as const;
      }),

    disable: (p, id, client) =>
      asApp(pool, p, async (db) => {
        if (!(await isAdmin(db))) return { ok: false, reason: "FORBIDDEN" } as const;
        const { rowCount } = await db.query(
          "update admin.connector set status = 'disabled', disabled_reason = 'ADMIN_DISABLED', updated_at = now() where id = $1 and workspace_id = $2",
          [id, p.workspaceId],
        );
        if (!rowCount) return { ok: false, reason: "NOT_FOUND" } as const;
        await audit(db, p, client, "connector.disabled", "connector", id, {});
        return { ok: true, value: (await view(db, p, id)) as Connector } as const;
      }),

    setUserPolicy: (p, id, tool, policy, client) =>
      asApp(pool, p, async (db) => {
        const t = (
          await db.query<ToolRow>(
            "select t.* from admin.connector_tool t where t.connector_id = $1 and t.name = $2 and t.workspace_id = $3",
            [id, tool, p.workspaceId],
          )
        ).rows[0];
        if (!t) return { ok: false, reason: "NOT_FOUND" } as const;
        // Tightening only: a person's rule can never be looser than the workspace's.
        const rank = { allow: 0, ask_user: 1, block: 2 } as const;
        if (rank[policy] < rank[t.policy])
          return { ok: false, reason: "POLICY_TIGHTEN_ONLY" } as const;
        await db.query(
          `insert into admin.connector_user_policy (workspace_id, connector_id, user_id, tool_name, policy)
           values ($1, $2, $3, $4, $5)
           on conflict (connector_id, user_id, tool_name) do update set policy = $5`,
          [p.workspaceId, id, p.userId, tool, policy],
        );
        await audit(db, p, client, "connector.user_policy_set", "connector", id, { tool, policy });
        return { ok: true, value: (await view(db, p, id)) as Connector } as const;
      }),

    decide: async (p, call, client) => {
      let failure: unknown = null;
      let decision: PolicyDecision;
      try {
        const loaded = await asApp(pool, p, async (db) => {
          const c = (
            await db.query<ConnRow>(
              "select * from admin.connector where id = $1 and workspace_id = $2",
              [call.connectorId, p.workspaceId],
            )
          ).rows[0];
          if (!c) return null;
          const t = (
            await db.query<ToolRow>(
              "select * from admin.connector_tool where connector_id = $1 and name = $2",
              [call.connectorId, call.toolName],
            )
          ).rows[0];
          const mine = (
            await db.query<{ policy: ToolPolicy }>(
              "select policy from admin.connector_user_policy where connector_id = $1 and user_id = $2 and tool_name = $3",
              [call.connectorId, p.userId, call.toolName],
            )
          ).rows[0];
          return { c, t, mine: mine?.policy ?? null };
        });
        // No connector row is an unknown connector: its status is read as disabled.
        const engineInput = {
          connector: {
            status: loaded?.c.status ?? "disabled",
            manifestMatchesPin:
              !!loaded?.c.manifest_hash && loaded.c.manifest_hash === call.observedManifestHash,
          },
          tool: loaded?.t ? { name: loaded.t.name, annotations: loaded.t.annotations } : null,
          workspacePolicy: loaded?.t?.policy,
          userPolicy: loaded?.mine ?? null,
          surface: call.surface,
          callsToToolInRun: call.callsToToolInRun,
          matterBlocksConnector: call.matterBlocksConnector ?? false,
          isWriteTool: loaded?.t ? WRITE_HINT(loaded.t.annotations) : false,
        };
        decision = createPolicyEngine({
          onFailClosed: (e) => {
            failure = e;
          },
        }).evaluate(engineInput);
      } catch (err) {
        failure = err;
        decision = {
          decision: "block",
          code: "POLICY_FAIL_CLOSED",
          reason: "Blocked by workspace policy: the policy could not be checked.",
        };
      }
      if (failure !== null || decision.code === "POLICY_FAIL_CLOSED") {
        // Best effort: a failing audit write must not turn a block into an error.
        await asApp(pool, p, (db) =>
          audit(db, p, client, "policy.fail_closed", "connector", call.connectorId, {
            tool: call.toolName,
          }),
        ).catch(() => undefined);
      }
      return decision;
    },
  };
}
