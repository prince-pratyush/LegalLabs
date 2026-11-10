import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { aiSdkProvider, type Message } from "./index.js";

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
