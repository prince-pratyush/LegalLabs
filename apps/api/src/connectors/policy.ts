import { ToolPolicy } from "@legallabs/contracts";
import { z } from "zod";

/**
 * Deterministic MCP tool-call policy engine (command-center-admin.md 4.10, CON-001, ADM-006).
 * Pure: no I/O, no clock, no randomness. Fail-closed: any problem yields `block`.
 */

/** Prior calls to one tool in a run at which the next call needs the user (the 21st call). */
export const CALL_LIMIT_PER_RUN = 20;

const STRICTNESS = { allow: 0, ask_user: 1, block: 2 } as const satisfies Record<
  ToolPolicy,
  number
>;

/** The more restrictive of two policies. */
export function tightest(a: ToolPolicy, b: ToolPolicy): ToolPolicy {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

const PolicyInputSchema = z.object({
  connector: z.object({
    status: z.enum(["pending_approval", "enabled", "disabled"]),
    manifestMatchesPin: z.boolean(),
  }),
  tool: z
    .object({
      name: z.string().min(1),
      annotations: z.record(z.string(), z.unknown()).optional(),
    })
    .nullable(),
  workspacePolicy: ToolPolicy,
  userPolicy: ToolPolicy.nullable().optional(),
  surface: z.enum(["interactive", "scheduled"]),
  callsToToolInRun: z.number().int().nonnegative(),
  matterBlocksConnector: z.boolean().optional(),
  isWriteTool: z.boolean().optional(),
});

export type PolicyInput = {
  connector: { status: "pending_approval" | "enabled" | "disabled"; manifestMatchesPin: boolean };
  /** null = unknown / undiscovered tool. */
  tool: { name: string; annotations?: Record<string, unknown> } | null;
  workspacePolicy: ToolPolicy | undefined;
  userPolicy?: ToolPolicy | null;
  surface: "interactive" | "scheduled";
  /** Number of prior calls to this tool in the run. */
  callsToToolInRun: number;
  matterBlocksConnector?: boolean;
  isWriteTool?: boolean;
};

export type PolicyDecision = { decision: ToolPolicy; code: string; reason: string };

const block = (code: string, reason: string): PolicyDecision => ({
  decision: "block",
  code,
  reason,
});

function decide(raw: unknown): PolicyDecision {
  const parsed = PolicyInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid policy input: ${parsed.error.message}`);
  }
  const i = parsed.data;

  if (i.tool === null) return block("TOOL_UNKNOWN", "Blocked: unknown tool");
  const name = i.tool.name;

  if (i.connector.status !== "enabled") {
    return block("CONNECTOR_DISABLED", `Blocked: connector is not enabled (${name})`);
  }
  if (!i.connector.manifestMatchesPin) {
    return block(
      "CONNECTOR_MANIFEST_CHANGED",
      `Blocked: connector manifest changed since approval (${name})`,
    );
  }
  if (i.matterBlocksConnector === true) {
    return block("MATTER_RESTRICTED", `Blocked: connector is restricted for this matter (${name})`);
  }
  if (i.workspacePolicy === "block") {
    return block("WORKSPACE_BLOCK", `Blocked by workspace policy: ${name}`);
  }
  if (i.userPolicy === "block") {
    return block("USER_BLOCK", `Blocked by your policy: ${name}`);
  }

  const annotations = i.tool.annotations ?? {};
  const destructive = annotations.destructiveHint === true;
  const isWrite = i.isWriteTool === true || destructive;
  if (isWrite && i.surface === "scheduled") {
    return block("SCHEDULED_WRITE", `Blocked: write tools cannot run unattended (${name})`);
  }

  // Tightest-wins; the user value can only raise strictness, never lower it.
  let decision: ToolPolicy = i.workspacePolicy;
  let code = decision === "allow" ? "ALLOW" : "WORKSPACE_ASK";
  let reason =
    decision === "allow" ? `Allowed: ${name}` : `Approval required by workspace policy: ${name}`;
  const escalate = (c: string, r: string) => {
    if (decision === "allow") {
      decision = "ask_user";
      code = c;
      reason = r;
    }
  };

  if (i.userPolicy === "ask_user")
    escalate("USER_ASK", `Approval required by your policy: ${name}`);
  if (destructive) escalate("DESTRUCTIVE_HINT", `Approval required: destructive tool (${name})`);
  if (annotations.openWorldHint === true) {
    escalate("OPEN_WORLD_HINT", `Approval required: tool reaches external systems (${name})`);
  }
  if (i.callsToToolInRun >= CALL_LIMIT_PER_RUN) {
    escalate(
      "CALL_LIMIT",
      `Approval required: more than ${CALL_LIMIT_PER_RUN} calls to ${name} in this run`,
    );
  }
  return { decision, code, reason };
}

/** Internal: returns the decision plus the thrown/invalid-input error, if any. */
function evaluateWithError(input: unknown): { result: PolicyDecision; error?: unknown } {
  try {
    return { result: decide(input) };
  } catch (error) {
    return {
      result: block("POLICY_FAIL_CLOSED", "Blocked: policy evaluation failed (fail-closed)"),
      error,
    };
  }
}

/** Single entry point. Never throws; anything unexpected becomes `block`. */
export function evaluatePolicy(input: unknown): PolicyDecision {
  return evaluateWithError(input).result;
}

export function createPolicyEngine(opts: { onFailClosed?: (err: unknown) => void } = {}) {
  return {
    evaluate(input: unknown): PolicyDecision {
      const { result, error } = evaluateWithError(input);
      if (error !== undefined) {
        try {
          opts.onFailClosed?.(error);
        } catch {
          // Audit hook failure must never change or escape the decision.
        }
      }
      return result;
    },
  };
}
