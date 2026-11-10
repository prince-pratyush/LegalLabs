export type ProviderId = "google" | "deepseek" | "anthropic" | "ollama";
export type TaskClass = "synthesize";

// US dollars per million tokens.
type Rate = { input: number; output: number };
type Price = Rate & { long?: Rate & { above_input_tokens: number } };

// client_data_safe is false where the provider may keep, review or train on content.
export type Route = {
  provider: ProviderId;
  model: string;
  client_data_safe: boolean;
  price: Price;
};

const FREE: Price = { input: 0, output: 0 };

// DeepSeek varies by time of day, so its peak rate is used.
export const ROUTES: Record<TaskClass, readonly Route[]> = {
  synthesize: [
    { provider: "google", model: "gemini-3.6-flash", client_data_safe: false, price: FREE },
    {
      provider: "deepseek",
      model: "deepseek-flash",
      client_data_safe: false,
      price: { input: 0.3, output: 1.2 },
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
    },
    { provider: "ollama", model: "llama3.2:3b", client_data_safe: true, price: FREE },
  ],
};

export function costUsd(price: Price, inputTokens: number, outputTokens: number): number {
  const rate = price.long && inputTokens > price.long.above_input_tokens ? price.long : price;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
