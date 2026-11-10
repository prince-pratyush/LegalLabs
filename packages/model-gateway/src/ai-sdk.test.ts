import { APICallError, registerTelemetry } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { aiSdkProvider, gatewayOptionsFromEnv, type Message } from "./index.js";

const messages: Message[] = [
  { role: "system", content: "Answer briefly." },
  { role: "user", content: "What is the notice period?" },
];

const generated = (inputTokens: number | undefined, outputTokens: number | undefined) => ({
  content: [{ type: "text" as const, text: "30 days" }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: {
      total: inputTokens,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: outputTokens, text: undefined, reasoning: undefined },
  },
  warnings: [],
});

describe("gatewayOptionsFromEnv", () => {
  it("configures nothing without keys, so nothing can be spent", () => {
    expect(gatewayOptionsFromEnv({})).toEqual({ providers: {}, allowDemoModels: false });
  });

  it("configures only the providers that have settings", () => {
    const { providers } = gatewayOptionsFromEnv({
      ANTHROPIC_API_KEY: "test-key",
      OLLAMA_BASE_URL: "http://localhost:11434",
      DEEPSEEK_API_KEY: "",
    });

    expect(Object.keys(providers).sort()).toEqual(["anthropic", "ollama"]);
  });

  it("configures DeepSeek and Gemini from their keys", () => {
    const { providers } = gatewayOptionsFromEnv({
      DEEPSEEK_API_KEY: "test-key",
      GOOGLE_GENERATIVE_AI_API_KEY: "test-key",
    });

    expect(Object.keys(providers).sort()).toEqual(["deepseek", "google"]);
  });

  it("allows demo models only for the exact word true", () => {
    const allowed = (value: string) =>
      gatewayOptionsFromEnv({ LEGALLABS_ALLOW_DEMO_MODELS: value }).allowDemoModels;

    expect(allowed("true")).toBe(true);
    expect(allowed("1")).toBe(false);
    expect(allowed("TRUE")).toBe(false);
  });
});

describe("aiSdkProvider", () => {
  it("returns the text and the usage the model reported", async () => {
    const mock = new MockLanguageModelV4({ doGenerate: async () => generated(12, 3) });

    const completion = await aiSdkProvider(() => mock).complete({
      model: "any",
      messages,
      max_output: 50,
    });

    expect(completion).toEqual({
      text: "30 days",
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    expect(mock.doGenerateCalls[0]?.maxOutputTokens).toBe(50);
  });

  it("reports no usage when the model gives none", async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: async () => generated(undefined, undefined),
    });

    const completion = await aiSdkProvider(() => mock).complete({
      model: "any",
      messages,
      max_output: 50,
    });

    expect(completion.usage).toBeUndefined();
  });

  it("sends nothing to a registered telemetry integration", async () => {
    let telemetryCalls = 0;
    registerTelemetry({
      onStart: () => {
        telemetryCalls += 1;
      },
    });
    const mock = new MockLanguageModelV4({ doGenerate: async () => generated(12, 3) });

    await aiSdkProvider(() => mock).complete({ model: "any", messages, max_output: 50 });

    expect(telemetryCalls).toBe(0);
  });

  it("leaves retrying to the gateway's fallback", async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: "overloaded",
          url: "https://example.test",
          requestBodyValues: {},
          isRetryable: true,
        });
      },
    });

    await expect(
      aiSdkProvider(() => mock).complete({ model: "any", messages, max_output: 50 }),
    ).rejects.toThrow();
    expect(mock.doGenerateCalls).toHaveLength(1);
  });
});
