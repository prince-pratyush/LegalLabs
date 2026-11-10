import { type ProviderId, ROUTES, type TaskClass } from "./routes.js";

export type Message = { role: "system" | "user" | "assistant"; content: string };

export type ModelProvider = {
  complete(request: {
    model: string;
    messages: readonly Message[];
    max_output: number;
  }): Promise<{ text: string; usage?: { input_tokens: number; output_tokens: number } }>;
};

export type GatewayCall = {
  task_class: TaskClass;
  messages: readonly Message[];
  budget: { max_output: number; max_cost_usd: number };
  routing: { workspace: string };
  trace: string;
};

export type GatewayResult = { output: string; model: string };

export type Gateway = { call(request: GatewayCall): Promise<GatewayResult> };

export type GatewayOptions = {
  providers: Partial<Record<ProviderId, ModelProvider>>;
  recordUsage: (record: unknown) => Promise<void>;
};

export function createGateway(options: GatewayOptions): Gateway {
  return {
    async call(request) {
      for (const route of ROUTES[request.task_class]) {
        const provider = options.providers[route.provider];
        if (!provider) continue;
        const { text } = await provider.complete({
          model: route.model,
          messages: request.messages,
          max_output: request.budget.max_output,
        });
        return { output: text, model: `${route.provider}/${route.model}` };
      }
      throw new Error("no model");
    },
  };
}
