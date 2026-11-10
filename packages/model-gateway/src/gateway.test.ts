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
});
