import { describe, expect, it } from "vitest";
import { createGateway, type ModelProvider } from "./index.js";

const answering = (text: string): ModelProvider => ({
  complete: async () => ({ text, usage: { input_tokens: 10, output_tokens: 5 } }),
});

const request = {
  task_class: "synthesize",
  messages: [{ role: "user", content: "What is the notice period?" }],
  budget: { max_output: 100, max_cost_usd: 1 },
  routing: { workspace: "ws_1" },
  trace: "trace_1",
} as const;

describe("gateway.call", () => {
  it("answers through a configured provider", async () => {
    const gateway = createGateway({
      providers: { anthropic: answering("30 days") },
      recordUsage: async () => {},
    });

    const result = await gateway.call(request);

    expect(result.output).toBe("30 days");
    expect(result.model).toBe("anthropic/claude-haiku-5-5");
  });

  it("skips models unsafe for client data by default", async () => {
    const gateway = createGateway({
      providers: {
        google: answering("from gemini"),
        deepseek: answering("from deepseek"),
        anthropic: answering("from haiku"),
      },
      recordUsage: async () => {},
    });

    expect((await gateway.call(request)).output).toBe("from haiku");
  });

  it("tries the free model first when demo models are switched on", async () => {
    const gateway = createGateway({
      providers: {
        anthropic: answering("from haiku"),
        deepseek: answering("from deepseek"),
        google: answering("from gemini"),
      },
      allowDemoModels: true,
      recordUsage: async () => {},
    });

    expect((await gateway.call(request)).output).toBe("from gemini");
  });
});
