import { describe, expect, it } from "vitest";
import { createGateway, GatewayError, type ModelProvider, type UsageRecord } from "./index.js";

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
    expect(result.model).toBe("ollama/qwen3:4b-instruct");
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

    expect(result.usage).toEqual({ input_tokens: 42, output_tokens: 100, estimated: true });
    expect(result.cost_usd).toBeCloseTo(0.0000542, 10);
  });

  it("does not under-count text with many bytes per character", async () => {
    const gateway = createGateway({
      providers: { anthropic: answering("from haiku") },
      recordUsage: async () => {},
    });

    await expect(
      gateway.call({
        ...request,
        messages: [{ role: "user", content: "条".repeat(90_000) }],
        budget: { max_output: 100, max_cost_usd: 0.05 },
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("skips a model whose worst case is over the cap", async () => {
    let haikuCalled = false;
    const gateway = createGateway({
      providers: {
        anthropic: {
          complete: async () => {
            haikuCalled = true;
            return { text: "from haiku" };
          },
        },
        ollama: answering("from llama"),
      },
      recordUsage: async () => {},
    });

    const result = await gateway.call({
      ...request,
      budget: { max_output: 100, max_cost_usd: 0.00001 },
    });

    expect(result.output).toBe("from llama");
    expect(haikuCalled).toBe(false);
  });

  it("stops when every usable model is over the cap", async () => {
    const gateway = createGateway({
      providers: { anthropic: answering("from haiku") },
      recordUsage: async () => {},
    });

    await expect(
      gateway.call({ ...request, budget: { max_output: 100, max_cost_usd: 0.00001 } }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("refuses a cap that is not a number", async () => {
    const gateway = createGateway({
      providers: { anthropic: answering("from haiku") },
      recordUsage: async () => {},
    });

    await expect(
      gateway.call({ ...request, budget: { max_output: 100, max_cost_usd: Number.NaN } }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("counts a failed attempt's worst case against the cap", async () => {
    const gateway = createGateway({
      providers: {
        deepseek: failing("timed out after billing"),
        anthropic: answering("from haiku"),
        ollama: answering("from llama"),
      },
      allowDemoModels: true,
      recordUsage: async () => {},
    });

    const result = await gateway.call({
      ...request,
      budget: { max_output: 100, max_cost_usd: 0.00015 },
    });

    expect(result.output).toBe("from llama");
  });

  it("records usage and timing without content", async () => {
    const records: UsageRecord[] = [];
    const times = [1_000, 1_250];
    const gateway = createGateway({
      providers: { anthropic: using(100_000, 200_000) },
      recordUsage: async (record) => {
        records.push(record);
      },
      now: () => times.shift() ?? 0,
    });

    const result = await gateway.call(request);

    expect(result.latency_ms).toBe(250);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workspace: "ws_1",
      trace: "trace_1",
      task_class: "synthesize",
      model: "anthropic/claude-haiku-5-5",
      usage: { input_tokens: 100_000, output_tokens: 200_000, estimated: false },
      latency_ms: 250,
    });
    expect(records[0]?.cost_usd).toBeCloseTo(0.11, 8);
    expect(JSON.stringify(records)).not.toContain("notice period");
  });

  it("does not pay twice when recording usage fails", async () => {
    let calls = 0;
    const counting: ModelProvider = {
      complete: async () => {
        calls += 1;
        return { text: "ok" };
      },
    };
    const gateway = createGateway({
      providers: { anthropic: counting, ollama: counting },
      recordUsage: async () => {
        throw new Error("ledger down");
      },
    });

    await expect(gateway.call(request)).rejects.toThrow("ledger down");
    expect(calls).toBe(1);
  });
});

const streaming = (chunks: string[], failAfter = Number.POSITIVE_INFINITY): ModelProvider => ({
  complete: async () => ({ text: chunks.join("") }),
  stream: async (_request, onText) => {
    for (const [i, chunk] of chunks.entries()) {
      if (i >= failAfter) throw new Error("connection reset");
      onText(chunk);
    }
    return { text: chunks.join(""), usage: { input_tokens: 3, output_tokens: chunks.length } };
  },
});

describe("gateway.stream", () => {
  it("passes text on as it arrives", async () => {
    const gateway = createGateway({
      providers: { anthropic: streaming(["Thirty ", "days."]) },
      recordUsage: async () => {},
    });
    const seen: string[] = [];

    const result = await gateway.stream(request, (delta) => seen.push(delta));

    expect(seen).toEqual(["Thirty ", "days."]);
    expect(result.output).toBe("Thirty days.");
    expect(result.usage).toEqual({ input_tokens: 3, output_tokens: 2, estimated: false });
  });

  it("streams a provider without streaming as one chunk", async () => {
    const gateway = createGateway({
      providers: { anthropic: answering("30 days") },
      recordUsage: async () => {},
    });
    const seen: string[] = [];

    await gateway.stream(request, (delta) => seen.push(delta));

    expect(seen).toEqual(["30 days"]);
  });

  it("falls back when a model fails before saying anything", async () => {
    const gateway = createGateway({
      providers: { anthropic: streaming(["x"], 0), ollama: streaming(["from qwen"]) },
      recordUsage: async () => {},
    });
    const seen: string[] = [];

    const result = await gateway.stream(request, (delta) => seen.push(delta));

    expect(seen).toEqual(["from qwen"]);
    expect(result.model).toBe("ollama/qwen3:4b-instruct");
  });

  it("stops rather than mixing two models' words", async () => {
    const gateway = createGateway({
      providers: { anthropic: streaming(["half ", "an answer"], 1), ollama: streaming(["other"]) },
      recordUsage: async () => {},
    });

    await expect(gateway.stream(request, () => {})).rejects.toMatchObject({
      code: "STREAM_INTERRUPTED",
    });
  });
});

describe("model choice", () => {
  const providers = { anthropic: answering("from haiku"), ollama: answering("from qwen") };

  it("tries the chosen model first", async () => {
    const gateway = createGateway({ providers, recordUsage: async () => {} });

    const result = await gateway.call({ ...request, model: "ollama/qwen3:4b-instruct" });

    expect(result.output).toBe("from qwen");
    expect(result.fallback).toBe(false);
    expect(result.requested_model).toBe("ollama/qwen3:4b-instruct");
  });

  it("says when it had to fall back from the chosen model", async () => {
    const gateway = createGateway({
      providers: { anthropic: answering("from haiku"), ollama: failing("down") },
      recordUsage: async () => {},
    });

    const result = await gateway.call({ ...request, model: "ollama/qwen3:4b-instruct" });

    expect(result.model).toBe("anthropic/claude-haiku-5-5");
    expect(result.fallback).toBe(true);
  });

  it("refuses a model the install can't use", async () => {
    const gateway = createGateway({ providers, recordUsage: async () => {} });

    await expect(
      gateway.call({ ...request, model: "google/gemini-3.6-flash" }),
    ).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED" });
  });

  it("lists only usable models, in routing order", () => {
    const gateway = createGateway({ providers, recordUsage: async () => {} });

    expect(gateway.models("synthesize").map((model) => model.id)).toEqual([
      "anthropic/claude-haiku-5-5",
      "ollama/qwen3:4b-instruct",
      "ollama/llama3.2:3b",
    ]);
  });

  it("sizes prompts for the smallest usable window", () => {
    const gateway = createGateway({ providers, recordUsage: async () => {} });
    const raised = createGateway({
      providers,
      contextWindows: { ollama: 32_768 },
      recordUsage: async () => {},
    });

    expect(gateway.contextTokens("synthesize")).toBe(4_096);
    expect(raised.contextTokens("synthesize")).toBe(32_768);
  });
});
