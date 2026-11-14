export type ProviderId = "google" | "deepseek" | "anthropic" | "ollama";
// Deep analysis plans, reads documents one by one, then writes the report.
export type TaskClass = "synthesize" | "plan" | "read_extract" | "draft_edit";

// US dollars per million tokens.
type Rate = { input: number; output: number };
type Price = Rate & { long?: Rate & { above_input_tokens: number } };

// client_data_safe is false where the provider may keep, review or train on content.
export type Route = {
  provider: ProviderId;
  model: string;
  client_data_safe: boolean;
  price: Price;
  /** Tokens the model can see at once, so callers can size what they send. */
  context_window: number;
};

const FREE: Price = { input: 0, output: 0 };

// DeepSeek varies by time of day, so its peak rate is used.
const GENERAL: readonly Route[] = [
  {
    provider: "google",
    model: "gemini-3.6-flash",
    client_data_safe: false,
    price: FREE,
    context_window: 1_000_000,
  },
  {
    provider: "deepseek",
    model: "deepseek-flash",
    client_data_safe: false,
    price: { input: 0.3, output: 1.2 },
    context_window: 128_000,
  },
  {
    provider: "anthropic",
    model: "claude-haiku-5-5",
    client_data_safe: true,
    price: {
      input: 0.1,
      output: 0.5,
      long: { above_input_tokens: 100_000, input: 0.5, output: 2.5 },
    },
    context_window: 200_000,
  },
  // Ollama serves 4k by default whatever the model allows; OLLAMA_CONTEXT_LENGTH raises it.
  {
    provider: "ollama",
    model: "qwen3:4b-instruct",
    client_data_safe: true,
    price: FREE,
    context_window: 4_096,
  },
  {
    provider: "ollama",
    model: "llama3.2:3b",
    client_data_safe: true,
    price: FREE,
    context_window: 4_096,
  },
];

export const ROUTES: Record<TaskClass, readonly Route[]> = {
  synthesize: GENERAL,
  plan: GENERAL,
  read_extract: GENERAL,
  draft_edit: GENERAL,
};

export function costUsd(price: Price, inputTokens: number, outputTokens: number): number {
  const rate = price.long && inputTokens > price.long.above_input_tokens ? price.long : price;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
