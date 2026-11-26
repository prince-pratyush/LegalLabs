import { createHash } from "node:crypto";
import type pg from "pg";
import type { AdminConnectors, OfferedTool } from "../admin-models/connectors.js";
import {
  type McpTransport,
  manifestHash,
  mcpSession,
  type RawTool,
  toolHash,
  uniqueTools,
} from "../admin-models/discovery.js";
import { scrub } from "../admin-models/secrets.js";
import type { Client, Principal } from "../auth/auth.js";
import { asApp } from "../db.js";
import { argumentProblem } from "./arguments.js";
import { sanitiseToolOutput } from "./sanitise.js";

/**
 * The only code that calls an MCP tool. Every call is decided by the policy engine first, the
 * server's live manifest is held to the pin, the connection goes through the guarded transport,
 * the reply is treated as untrusted data, and each decision and call is audited. There is no
 * other path to `tools/call`.
 */

export interface ToolCallInput {
  runId: string;
  matterId: string | null;
  /** False for scheduled and other unattended runs: nothing can be asked, so asking blocks. */
  interactive: boolean;
  /** The tools this run was told about. A name outside it is an unknown tool. */
  offered: readonly OfferedTool[];
  call: { name: string; arguments: unknown };
  /** Earlier calls to the same tool in this run. */
  priorCalls(connectorId: string, tool: string): number;
  /** What a person approved. It counts only for this connector, tool and these arguments. */
  approval?: { connectorId: string; toolHash: string; argsHash: string };
  signal?: AbortSignal;
  /** Called just before the request leaves, so a retry knows the call may have happened. */
  onSend?: () => Promise<void>;
}

interface Target {
  connectorId: string | null;
  connectorName: string;
  tool: string;
  argsHash: string;
}

export type ToolOutcome = Target &
  (
    | { status: "blocked"; code: string; reason: string }
    | {
        status: "needs_approval";
        code: string;
        reason: string;
        args: Record<string, unknown>;
        toolHash: string;
      }
    | {
        status: "ok" | "error";
        /** Sanitised; the only form that may enter a prompt. */
        text: string;
        /** As the server sent it, capped, for the person to inspect. Never prompt it. */
        raw: string;
        flagged: number;
        bytes: number;
        durationMs: number;
      }
  );

export interface ToolExecutor {
  offered: AdminConnectors["offered"];
  execute(p: Principal, input: ToolCallInput): Promise<ToolOutcome>;
}

export interface ToolExecutorOptions {
  connectors: Pick<AdminConnectors, "offered" | "endpoint" | "decide" | "reportDrift">;
  /** Tests serve a local fake; the default refuses private addresses. */
  transport?: McpTransport;
  timeoutMs?: number;
}

const NO_CLIENT: Client = { ip: null, userAgent: null };
const RAW_CAP = 100_000;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const argumentsHash = (args: unknown) =>
  createHash("sha256").update(canonical(args)).digest("hex");

export function createToolExecutor(pool: pg.Pool, options: ToolExecutorOptions): ToolExecutor {
  const { connectors, transport } = options;

  /** Ids, hashes and counts only: arguments and results never enter the audit trail. */
  const audit = (
    p: Principal,
    runId: string,
    action: string,
    connectorId: string | null,
    details: Record<string, unknown>,
  ) =>
    asApp(pool, p, (db) =>
      db.query(
        "select admin.append_audit_event($1, 'agent', $2, 'connector', $3, $4, null, null)",
        [
          action,
          runId,
          connectorId ?? "unknown",
          JSON.stringify({ ...details, run_id: runId, on_behalf_of: p.userId }),
        ],
      ),
    );

  async function execute(p: Principal, input: ToolCallInput): Promise<ToolOutcome> {
    const { runId } = input;
    const known = input.offered.find((t) => t.name === input.call.name);
    const target: Target = {
      connectorId: known?.connectorId ?? null,
      connectorName: known?.connectorName ?? "",
      tool: known?.tool ?? input.call.name.slice(0, 200),
      argsHash: argumentsHash(input.call.arguments),
    };
    const record = (decision: string, code: string) =>
      audit(p, runId, "connector.tool_called", target.connectorId, {
        tool: target.tool,
        decision,
        code,
        args_hash: target.argsHash,
      });
    const blocked = async (code: string, reason: string): Promise<ToolOutcome> => {
      await record("block", code);
      return { ...target, status: "blocked", code, reason };
    };

    if (!known) return blocked("TOOL_UNKNOWN", "Blocked: unknown tool");

    const base = {
      connectorId: known.connectorId,
      toolName: known.tool,
      surface: input.interactive ? ("interactive" as const) : ("scheduled" as const),
      callsToToolInRun: input.priorCalls(known.connectorId, known.tool),
    };
    const endpoint = await connectors.endpoint(p, known.connectorId, known.tool);
    // Ruled on before the server is contacted: a connector that is off, or a tool that is
    // blocked, gets no request and no key.
    const first = await connectors.decide(
      p,
      { ...base, observedManifestHash: endpoint?.manifestHash },
      NO_CLIENT,
    );
    if (first.decision === "block") return blocked(first.code, first.reason);
    if (!endpoint) {
      return blocked("CONNECTOR_UNAVAILABLE", `Blocked: connector can't be used (${known.name})`);
    }

    const problem = argumentProblem(input.call.arguments, known.inputSchema);
    if (problem) return blocked("ARGUMENTS_INVALID", `Blocked: ${problem}`);
    const args = input.call.arguments as Record<string, unknown>;

    const session = mcpSession(endpoint.url, endpoint.auth, {
      ...(transport ? { transport } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    let live: RawTool[];
    try {
      live = uniqueTools(await session.listTools());
    } catch {
      // Unreachable isn't drift: the call is refused and the connector is left as it was.
      return blocked("CONNECTOR_UNAVAILABLE", `Blocked: the connector didn't answer`);
    }
    const observed = manifestHash(live.map(toolHash));
    const decision = await connectors.decide(
      p,
      { ...base, observedManifestHash: observed },
      NO_CLIENT,
    );
    if (decision.code === "CONNECTOR_MANIFEST_CHANGED") {
      await connectors.reportDrift(p, known.connectorId, NO_CLIENT);
    }
    if (decision.decision === "block") return blocked(decision.code, decision.reason);

    if (decision.decision === "ask_user") {
      // The tool as the server presents it now, not as it was pinned when this call began: an
      // admin may have re-approved a changed tool in between.
      const presented = live.find((t) => t.name === known.tool);
      const liveHash = presented ? toolHash(presented) : endpoint.toolHash;
      const approved =
        input.approval?.argsHash === target.argsHash &&
        input.approval.connectorId === known.connectorId &&
        input.approval.toolHash === liveHash;
      if (!approved) {
        if (!input.interactive) {
          return blocked(
            "UNATTENDED_APPROVAL",
            `Blocked: needs approval and no one is there to give it (${known.name})`,
          );
        }
        await record("ask_user", decision.code);
        return {
          ...target,
          status: "needs_approval",
          code: decision.code,
          reason: decision.reason,
          args,
          toolHash: liveHash,
        };
      }
    }

    // Written before the request: if the trail can't be kept, nothing is sent.
    await audit(p, runId, "run.tool.policy", known.connectorId, {
      tool: known.tool,
      decision: decision.decision,
      approved: decision.decision === "ask_user",
      args_hash: target.argsHash,
    });
    await input.onSend?.();

    const started = Date.now();
    let reply: { text: string; isError: boolean };
    try {
      reply = await session.callTool(known.tool, args);
    } catch {
      // The transport's own message can name addresses, so it isn't passed on.
      reply = { text: "The connector didn't return a result.", isError: true };
    }
    const secret = endpoint.auth.kind === "bearer" ? [endpoint.auth.token] : [];
    const raw = scrub(reply.text.slice(0, RAW_CAP), secret);
    const clean = sanitiseToolOutput(raw);
    const durationMs = Date.now() - started;
    const bytes = Buffer.byteLength(reply.text, "utf8");
    await audit(p, runId, "connector.tool_called", known.connectorId, {
      tool: known.tool,
      decision: decision.decision,
      args_hash: target.argsHash,
      duration_ms: durationMs,
      output_bytes: bytes,
      ok: !reply.isError,
      flagged: clean.flagged,
    });
    return {
      ...target,
      status: reply.isError ? "error" : "ok",
      text: clean.text,
      raw,
      flagged: clean.flagged,
      bytes,
      durationMs,
    };
  }

  return { offered: (p, scopes) => connectors.offered(p, scopes), execute };
}
