export type ProviderId = "google" | "deepseek" | "anthropic" | "ollama";
export type TaskClass = "synthesize";

// client_data is false where the provider may keep, review or train on content.
export type Route = { provider: ProviderId; model: string; client_data: boolean };

export const ROUTES: Record<TaskClass, readonly Route[]> = {
  synthesize: [
    { provider: "google", model: "gemini-3.6-flash", client_data: false },
    { provider: "deepseek", model: "deepseek-flash", client_data: false },
    { provider: "anthropic", model: "claude-haiku-5-5", client_data: true },
    { provider: "ollama", model: "llama3.2:3b", client_data: true },
  ],
};
