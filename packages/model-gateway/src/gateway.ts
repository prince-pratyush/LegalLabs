import { costUsd, type ProviderId, ROUTES, type TaskClass } from "./routes.js";

export type Message = { role: "system" | "user" | "assistant"; content: string };

export type Completion = {
  text: string;
  usage?: { input_tokens: number; output_tokens: number };
};

export type ModelProvider = {
  complete(request: {
    model: string;
    messages: readonly Message[];
    max_output: number;
  }): Promise<Completion>;
};

export type Usage = { input_tokens: number; output_tokens: number; estimated: boolean };

export type GatewayCall = {
  task_class: TaskClass;
  messages: readonly Message[];
  budget: { max_output: number; max_cost_usd: number };
  routing: { workspace: string };
  trace: string;
};

export type GatewayResult = { output: string; model: string; usage: Usage; cost_usd: number };

export type Gateway = { call(request: GatewayCall): Promise<GatewayResult> };

export type GatewayOptions = {
  providers: Partial<Record<ProviderId, ModelProvider>>;
  allowDemoModels?: boolean;
  recordUsage: (record: unknown) => Promise<void>;
};

export type GatewayErrorCode = "NO_MODEL_AVAILABLE" | "ALL_MODELS_FAILED";

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    readonly attempted: readonly string[],
  ) {
    super(`${code}: ${attempted.join(", ") || "no models tried"}`);
    this.name = "GatewayError";
  }
}

export function createGateway(options: GatewayOptions): Gateway {
  return {
    async call(request) {
      const attempted: string[] = [];
      for (const route of ROUTES[request.task_class]) {
        const provider = options.providers[route.provider];
        if (!provider || (!route.client_data && !options.allowDemoModels)) continue;
        const model = `${route.provider}/${route.model}`;
        let completion: Completion;
        try {
          completion = await provider.complete({
            model: route.model,
            messages: request.messages,
            max_output: request.budget.max_output,
          });
        } catch {
          // The provider's error is dropped because it can quote the prompt.
          attempted.push(model);
          continue;
        }
        const usage = {
          input_tokens: completion.usage?.input_tokens ?? 0,
          output_tokens: completion.usage?.output_tokens ?? 0,
          estimated: false,
        };
        return {
          output: completion.text,
          model,
          usage,
          cost_usd: costUsd(route.price, usage.input_tokens, usage.output_tokens),
        };
      }
      throw new GatewayError(attempted.length ? "ALL_MODELS_FAILED" : "NO_MODEL_AVAILABLE", attempted);
    },
  };
}
