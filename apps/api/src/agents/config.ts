import { type ApprovalConfig, DEFAULT_APPROVAL } from "@legallabs/contracts";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp } from "../db.js";

/** Which shares wait for approval, set by admins under Configurations → Sharing. */
export interface AgentSharing {
  get(principal: Principal): Promise<ApprovalConfig>;
  /** False unless the caller holds admin.config. */
  set(principal: Principal, config: ApprovalConfig, client: Client): Promise<boolean>;
}

export function createAgentSharing(pool: pg.Pool): AgentSharing {
  return {
    get: (principal) =>
      asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ i: boolean; g: boolean; w: boolean }>(
          `select require_individual i, require_group g, require_workspace w
             from work.sharing_config where workspace_id = $1`,
          [principal.workspaceId],
        );
        const r = rows[0];
        return r ? { individual: r.i, group: r.g, workspace: r.w } : DEFAULT_APPROVAL;
      }),

    set: (principal, config, client) =>
      asApp(pool, principal, async (db) => {
        const { rows: ok } = await db.query<{ a: boolean }>(
          "select core.has_permission('admin.config') a",
        );
        if (!ok[0]?.a) return false;
        await db.query(
          `insert into work.sharing_config (workspace_id, require_individual, require_group, require_workspace)
           values ($1, $2, $3, $4)
           on conflict (workspace_id) do update set require_individual = $2, require_group = $3,
             require_workspace = $4, updated_at = now()`,
          [principal.workspaceId, config.individual, config.group, config.workspace],
        );
        await db.query(
          "select admin.append_audit_event('settings.changed', 'user', $1, 'workspace', $2, $3, $4, $5)",
          [
            principal.userId,
            principal.workspaceId,
            JSON.stringify({ setting: "sharing.require_approval" }),
            client.ip,
            uaHash(client),
          ],
        );
        return true;
      }),
  };
}
