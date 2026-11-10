import { generateText, type LanguageModel } from "ai";
import type { ModelProvider } from "./gateway.js";

const TIMEOUT_MS = 120_000;

export function aiSdkProvider(modelFor: (id: string) => LanguageModel): ModelProvider {
  return {
    async complete({ model, messages, max_output }) {
      const { text, usage } = await generateText({
        model: modelFor(model),
        messages: [...messages],
        allowSystemInMessages: true,
        maxOutputTokens: max_output,
        // The gateway falls back to another model, so retries here would only add delay.
        maxRetries: 0,
        timeout: TIMEOUT_MS,
      });
      const { inputTokens, outputTokens } = usage;
      if (inputTokens === undefined || outputTokens === undefined) return { text };
      return { text, usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
    },
  };
}
