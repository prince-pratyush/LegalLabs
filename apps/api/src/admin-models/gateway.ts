import {
  createGateway,
  type Gateway,
  type GatewayOptions,
  type Routing,
  type WorkspaceModels,
} from "@legallabs/model-gateway";
import type pg from "pg";
import { asWorker } from "../db.js";
import { type StoredSettings, workspaceRule } from "./settings.js";

async function readSettings(pool: pg.Pool, routing: Routing): Promise<WorkspaceModels> {
  const stored = await asWorker(
    pool,
    async (db) =>
      (
        await db.query<{ s: StoredSettings | null }>("select admin.model_settings($1, $2) s", [
          routing.workspace,
          routing.user,
        ])
      ).rows[0]?.s,
  );
  // No answer is not the same as no settings: the gateway refuses.
  if (!stored) throw new Error("workspace not found");
  return workspaceRule(stored, routing.user);
}

// A code or a class name only: a driver's message can quote stored values.
function codeOf(err: unknown): string {
  const { code, name } = (err ?? {}) as { code?: unknown; name?: unknown };
  const found = [code, name].find((v) => typeof v === "string" && /^\w{1,60}$/.test(v));
  return typeof found === "string" ? found : "unknown";
}

/**
 * The only way this app builds a gateway: every call it makes obeys the workspace's model
 * settings, read fresh each time.
 */
export const createWorkspaceGateway = (
  pool: pg.Pool,
  options: Omit<GatewayOptions, "workspacePolicy">,
): Gateway =>
  createGateway({
    ...options,
    workspacePolicy: (routing) =>
      readSettings(pool, routing).catch((err: unknown) => {
        // The gateway only refuses, so the cause is noted here.
        console.error(
          `model settings read failed: workspace=${routing.workspace} code=${codeOf(err)}`,
        );
        throw err;
      }),
  });
