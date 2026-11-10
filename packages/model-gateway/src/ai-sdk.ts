import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel } from "ai";
import type { GatewayOptions, ModelProvider } from "./gateway.js";

const TIMEOUT_MS = 120_000;

type Env = Record<string, string | undefined>;

// A provider with no setting is left out, so it can never be called or billed.
export function gatewayOptionsFromEnv(env: Env): Omit<GatewayOptions, "recordUsage" | "now"> {
  const providers: GatewayOptions["providers"] = {};
  if (env.ANTHROPIC_API_KEY) {
    const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
    providers.anthropic = aiSdkProvider((id) => anthropic.languageModel(id));
  }
  if (env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
    providers.google = aiSdkProvider((id) => google.languageModel(id));
  }
  if (env.DEEPSEEK_API_KEY) {
    const deepseek = createOpenAICompatible({
      name: "deepseek",
      baseURL: "https://api.deepseek.com",
      apiKey: env.DEEPSEEK_API_KEY,
    });
    providers.deepseek = aiSdkProvider((id) => deepseek.languageModel(id));
  }
  if (env.OLLAMA_BASE_URL) {
    const ollama = createOpenAICompatible({
      name: "ollama",
      baseURL: `${env.OLLAMA_BASE_URL}/v1`,
    });
    providers.ollama = aiSdkProvider((id) => ollama.languageModel(id));
  }
  return { providers, allowDemoModels: env.LEGALLABS_ALLOW_DEMO_MODELS === "true" };
}

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
        // Off explicitly: a registered integration would otherwise export prompts.
        telemetry: { isEnabled: false },
      });
      const { inputTokens, outputTokens } = usage;
      if (inputTokens === undefined || outputTokens === undefined) return { text };
      return { text, usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
    },
  };
}
