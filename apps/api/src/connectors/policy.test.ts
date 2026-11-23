import { describe, expect, it, vi } from "vitest";
import { createPolicyEngine, evaluatePolicy, type PolicyInput, tightest } from "./policy.js";

const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  connector: { status: "enabled", manifestMatchesPin: true },
  tool: { name: "search_docs" },
  workspacePolicy: "allow",
  surface: "interactive",
  callsToToolInRun: 0,
  ...over,
});

describe("base policies", () => {
  it.each(["allow", "ask_user", "block"] as const)("workspace %s is honoured", (p) => {
    expect(evaluatePolicy(base({ workspacePolicy: p })).decision).toBe(p);
  });
  it("workspace block message", () => {
    const d = evaluatePolicy(base({ workspacePolicy: "block" }));
    expect(d.code).toBe("WORKSPACE_BLOCK");
    expect(d.reason).toBe("Blocked by workspace policy: search_docs");
  });
});

describe("user policy tightens only", () => {
  it("user block beats workspace allow", () => {
    const d = evaluatePolicy(base({ userPolicy: "block" }));
    expect(d.decision).toBe("block");
    expect(d.reason).toBe("Blocked by your policy: search_docs");
  });
  it("user ask_user turns allow into ask_user", () => {
    expect(evaluatePolicy(base({ userPolicy: "ask_user" })).decision).toBe("ask_user");
  });
  it("user allow never loosens ask_user or block", () => {
    expect(
      evaluatePolicy(base({ workspacePolicy: "ask_user", userPolicy: "allow" })).decision,
    ).toBe("ask_user");
    expect(evaluatePolicy(base({ workspacePolicy: "block", userPolicy: "allow" })).decision).toBe(
      "block",
    );
  });
  it("user ask_user never loosens workspace block", () => {
    expect(
      evaluatePolicy(base({ workspacePolicy: "block", userPolicy: "ask_user" })).decision,
    ).toBe("block");
  });
  it("null user policy is ignored", () => {
    expect(evaluatePolicy(base({ userPolicy: null })).decision).toBe("allow");
  });
});

describe("annotations", () => {
  it("destructiveHint raises allow to ask_user", () => {
    expect(
      evaluatePolicy(base({ tool: { name: "t", annotations: { destructiveHint: true } } }))
        .decision,
    ).toBe("ask_user");
  });
  it("openWorldHint raises allow to ask_user", () => {
    expect(
      evaluatePolicy(base({ tool: { name: "t", annotations: { openWorldHint: true } } })).decision,
    ).toBe("ask_user");
  });
  it("non-true hints do not raise", () => {
    expect(
      evaluatePolicy(
        base({
          tool: { name: "t", annotations: { destructiveHint: "true", openWorldHint: false } },
        }),
      ).decision,
    ).toBe("allow");
  });
  it("hints never loosen block", () => {
    expect(
      evaluatePolicy(
        base({
          workspacePolicy: "block",
          tool: { name: "t", annotations: { destructiveHint: true } },
        }),
      ).decision,
    ).toBe("block");
  });
});

describe("scheduled surface", () => {
  it("destructive tool -> block (CON-001-a)", () => {
    expect(
      evaluatePolicy(
        base({ surface: "scheduled", tool: { name: "t", annotations: { destructiveHint: true } } }),
      ).decision,
    ).toBe("block");
  });
  it("isWriteTool -> block", () => {
    expect(evaluatePolicy(base({ surface: "scheduled", isWriteTool: true })).decision).toBe(
      "block",
    );
  });
  it("write tool interactive -> ask_user even when the workspace says allow", () => {
    const d = evaluatePolicy(base({ isWriteTool: true }));
    expect(d.decision).toBe("ask_user");
    expect(d.code).toBe("WRITE_TOOL");
  });
  it("read tool scheduled -> allow", () => {
    expect(evaluatePolicy(base({ surface: "scheduled" })).decision).toBe("allow");
  });
});

describe("call limit (CON-001-d)", () => {
  it("19 prior calls (20th) stays allow", () => {
    expect(evaluatePolicy(base({ callsToToolInRun: 19 })).decision).toBe("allow");
  });
  it("20 prior calls (21st) is ask_user", () => {
    expect(evaluatePolicy(base({ callsToToolInRun: 20 })).decision).toBe("ask_user");
  });
  it("negative or fractional counts fail closed", () => {
    expect(evaluatePolicy(base({ callsToToolInRun: -1 })).code).toBe("POLICY_FAIL_CLOSED");
    expect(evaluatePolicy(base({ callsToToolInRun: 1.5 })).code).toBe("POLICY_FAIL_CLOSED");
  });
});

describe("hard blocks", () => {
  it("unknown tool", () => {
    expect(evaluatePolicy(base({ tool: null }))).toMatchObject({
      decision: "block",
      code: "TOOL_UNKNOWN",
    });
  });
  it("missing workspace policy fails closed", () => {
    expect(evaluatePolicy(base({ workspacePolicy: undefined }))).toMatchObject({
      decision: "block",
      code: "POLICY_FAIL_CLOSED",
    });
  });
  it.each(["disabled", "pending_approval"] as const)("connector %s", (status) => {
    expect(evaluatePolicy(base({ connector: { status, manifestMatchesPin: true } }))).toMatchObject(
      {
        decision: "block",
        code: "CONNECTOR_DISABLED",
      },
    );
  });
  it("manifest drift (ADM-006-c)", () => {
    expect(
      evaluatePolicy(base({ connector: { status: "enabled", manifestMatchesPin: false } })),
    ).toMatchObject({
      decision: "block",
      code: "CONNECTOR_MANIFEST_CHANGED",
    });
  });
  it("matter restriction", () => {
    expect(evaluatePolicy(base({ matterBlocksConnector: true }))).toMatchObject({
      decision: "block",
      code: "MATTER_RESTRICTED",
    });
  });
});

describe("fail closed (CON-001-c)", () => {
  const throwing = new Proxy(
    {},
    {
      get() {
        throw new Error("boom");
      },
      has() {
        throw new Error("boom");
      },
      ownKeys() {
        throw new Error("boom");
      },
    },
  );
  const garbage: unknown[] = [
    null,
    undefined,
    42,
    "allow",
    [],
    {},
    throwing,
    base({ surface: "web" as never }),
    base({ workspacePolicy: "always_allow" as never }),
    base({ userPolicy: "maybe" as never }),
    base({ tool: { name: "" } }),
    { ...base(), connector: null },
  ];
  it.each(garbage.map((g, n) => [n, g]))("garbage #%i -> block", (_n, g) => {
    expect(evaluatePolicy(g)).toMatchObject({ decision: "block", code: "POLICY_FAIL_CLOSED" });
  });
  it("engine reports each failure via onFailClosed", () => {
    const onFailClosed = vi.fn();
    const engine = createPolicyEngine({ onFailClosed });
    for (const g of garbage) expect(engine.evaluate(g).decision).toBe("block");
    expect(onFailClosed).toHaveBeenCalledTimes(garbage.length);
  });
  it("does not report normal decisions", () => {
    const onFailClosed = vi.fn();
    const engine = createPolicyEngine({ onFailClosed });
    engine.evaluate(base({ tool: null }));
    engine.evaluate(base());
    expect(onFailClosed).not.toHaveBeenCalled();
  });
  it("a throwing onFailClosed does not escape", () => {
    const engine = createPolicyEngine({
      onFailClosed: () => {
        throw new Error("audit down");
      },
    });
    expect(engine.evaluate(null)).toMatchObject({ decision: "block", code: "POLICY_FAIL_CLOSED" });
  });
  it("works without options", () => {
    expect(createPolicyEngine().evaluate(undefined).decision).toBe("block");
  });
});

describe("tightest", () => {
  it("orders allow < ask_user < block", () => {
    expect(tightest("allow", "ask_user")).toBe("ask_user");
    expect(tightest("block", "allow")).toBe("block");
    expect(tightest("ask_user", "block")).toBe("block");
    expect(tightest("allow", "allow")).toBe("allow");
  });
});

describe("allow only when every condition is clean", () => {
  it("exhaustive combination check", () => {
    let combos = 0;
    let allows = 0;
    const statuses = ["enabled", "disabled", "pending_approval"] as const;
    const tools = [
      null,
      { name: "t" },
      { name: "t", annotations: { destructiveHint: true } },
      { name: "t", annotations: { openWorldHint: true } },
    ];
    for (const status of statuses)
      for (const manifestMatchesPin of [true, false])
        for (const tool of tools)
          for (const workspacePolicy of [undefined, "allow", "ask_user", "block"] as const)
            for (const userPolicy of [undefined, null, "allow", "ask_user", "block"] as const)
              for (const surface of ["interactive", "scheduled"] as const)
                for (const callsToToolInRun of [0, 19, 20, 50])
                  for (const matterBlocksConnector of [undefined, false, true])
                    for (const isWriteTool of [undefined, false, true]) {
                      combos++;
                      const d = evaluatePolicy({
                        connector: { status, manifestMatchesPin },
                        tool,
                        workspacePolicy,
                        userPolicy,
                        surface,
                        callsToToolInRun,
                        matterBlocksConnector,
                        isWriteTool,
                      });
                      const clean =
                        status === "enabled" &&
                        manifestMatchesPin &&
                        tool !== null &&
                        !tool.annotations &&
                        workspacePolicy === "allow" &&
                        (userPolicy === undefined ||
                          userPolicy === null ||
                          userPolicy === "allow") &&
                        !(surface === "scheduled" && isWriteTool === true) &&
                        isWriteTool !== true &&
                        callsToToolInRun < 20 &&
                        matterBlocksConnector !== true;
                      if (d.decision === "allow") allows++;
                      expect(d.decision === "allow").toBe(clean);
                    }
    expect(combos).toBeGreaterThan(5000);
    expect(allows).toBeGreaterThan(0);
  });
});
