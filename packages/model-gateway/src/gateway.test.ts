import { describe, expect, it } from "vitest";
import { createGateway, GatewayError, type ModelProvider } from "./index.js";

const answering = (text: string): ModelProvider => ({
  complete: async () => ({ text, usage: { input_tokens: 10, output_tokens: 5 } }),
});

const failing = (message: string): ModelProvider => ({
  complete: async () => {
    throw new Error(message);
  },
});

const using = (input_tokens: number, output_tokens: number): ModelProvider => ({
  complete: async () => ({ text: "ok", usage: { input_tokens, output_tokens } }),
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

  it("falls back to the next model when one fails", async () => {
    const gateway = createGateway({
      providers: { anthropic: failing("overloaded"), ollama: answering("from llama") },
      recordUsage: async () => {},
    });

    const result = await gateway.call(request);

    expect(result.output).toBe("from llama");
    expect(result.model).toBe("ollama/llama3.2:3b");
  });

  it("names the failed models without repeating provider errors", async () => {
    const gateway = createGateway({
      providers: { anthropic: failing("rejected: What is the notice period?") },
      recordUsage: async () => {},
    });

    const error = await gateway.call(request).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe("ALL_MODELS_FAILED");
    expect((error as GatewayError).attempted).toEqual(["anthropic/claude-haiku-5-5"]);
    expect(JSON.stringify(error)).not.toContain("notice period");
    expect((error as GatewayError).message).not.toContain("notice period");
  });

  it("reports when no usable model is configured", async () => {
    const gateway = createGateway({
      providers: { google: answering("from gemini") },
      recordUsage: async () => {},
    });

    await expect(gateway.call(request)).rejects.toMatchObject({ code: "NO_MODEL_AVAILABLE" });
  });

  it("works out cost from the model's prices", async () => {
    const gateway = createGateway({
      providers: { anthropic: using(100_000, 200_000) },
      recordUsage: async () => {},
    });

    const result = await gateway.call(request);

    expect(result.usage).toEqual({
      input_tokens: 100_000,
      output_tokens: 200_000,
      estimated: false,
    });
    expect(result.cost_usd).toBeCloseTo(0.11, 8);
  });

  it("charges the long-prompt rate above its threshold", async () => {
    const gateway = createGateway({
      providers: { anthropic: using(200_000, 100_000) },
      recordUsage: async () => {},
    });

    expect((await gateway.call(request)).cost_usd).toBeCloseTo(0.35, 8);
  });

  it("charges nothing for a local model", async () => {
    const gateway = createGateway({
      providers: { ollama: using(200_000, 100_000) },
      recordUsage: async () => {},
    });

    expect((await gateway.call(request)).cost_usd).toBe(0);
  });

  it("assumes the worst when a model reports no usage", async () => {
    const gateway = createGateway({
      providers: { anthropic: { complete: async () => ({ text: "ok" }) } },
      recordUsage: async () => {},
    });

    const result = await gateway.call(request);

    expect(result.usage).toEqual({ input_tokens: 26, output_tokens: 100, estimated: true });
    expect(result.cost_usd).toBeCloseTo(0.0000526, 10);
  });
});
