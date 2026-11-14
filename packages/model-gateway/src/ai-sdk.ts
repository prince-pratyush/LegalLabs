import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel, streamText } from "ai";
import type { Completion, GatewayOptions, Message, ModelProvider } from "./gateway.js";

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
  // The same setting the Ollama server reads, so both sides agree on the window.
  const ollamaWindow = Number(env.OLLAMA_CONTEXT_LENGTH);
  return {
    providers,
    allowDemoModels: env.LEGALLABS_ALLOW_DEMO_MODELS === "true",
    ...(Number.isInteger(ollamaWindow) && ollamaWindow > 0
      ? { contextWindows: { ollama: ollamaWindow } }
      : {}),
  };
}

type Counted = { inputTokens: number | undefined; outputTokens: number | undefined };

const completion = (text: string, { inputTokens, outputTokens }: Counted): Completion =>
  inputTokens === undefined || outputTokens === undefined
    ? { text }
    : { text, usage: { input_tokens: inputTokens, output_tokens: outputTokens } };

export function aiSdkProvider(modelFor: (id: string) => LanguageModel): ModelProvider {
  const settings = (model: string, messages: readonly Message[], max_output: number) => ({
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
  return {
    async complete({ model, messages, max_output }) {
      const { text, usage } = await generateText(settings(model, messages, max_output));
      return completion(text, usage);
    },
    async stream({ model, messages, max_output, signal }, onText) {
      let failure: unknown = null;
      const result = streamText({
        ...settings(model, messages, max_output),
        ...(signal ? { abortSignal: signal } : {}),
        onError: ({ error }) => {
          failure = error;
        },
      });
      let text = "";
      for await (const delta of result.textStream) {
        text += delta;
        onText(delta);
      }
      // The stream ends quietly on error, so the failure is raised here for the gateway.
      if (failure !== null) throw failure;
      return completion(text, await result.usage);
    },
  };
}
