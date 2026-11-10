export type ProviderId = "google" | "deepseek" | "anthropic" | "ollama";
export type TaskClass = "synthesize";

export type Route = { provider: ProviderId; model: string };

export const ROUTES: Record<TaskClass, readonly Route[]> = {
  synthesize: [
    { provider: "google", model: "gemini-3.6-flash" },
    { provider: "deepseek", model: "deepseek-flash" },
    { provider: "anthropic", model: "claude-haiku-5-5" },
    { provider: "ollama", model: "llama3.2:3b" },
  ],
};
