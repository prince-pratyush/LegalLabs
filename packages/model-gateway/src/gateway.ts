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

type Measured = { model: string; usage: Usage; cost_usd: number; latency_ms: number };

export type GatewayResult = Measured & { output: string };

export type UsageRecord = Measured & { workspace: string; trace: string; task_class: TaskClass };

export type Gateway = { call(request: GatewayCall): Promise<GatewayResult> };

export type GatewayOptions = {
  providers: Partial<Record<ProviderId, ModelProvider>>;
  allowDemoModels?: boolean;
  recordUsage: (record: UsageRecord) => Promise<void>;
  now?: () => number;
};

export type GatewayErrorCode = "NO_MODEL_AVAILABLE" | "BUDGET_EXCEEDED" | "ALL_MODELS_FAILED";

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    readonly attempted: readonly string[],
  ) {
    super(`${code}: ${attempted.join(", ") || "no models tried"}`);
    this.name = "GatewayError";
  }
}

// A token is at least about one character, so this cannot under-count.
function inputUpperBound(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

export function createGateway(options: GatewayOptions): Gateway {
  const now = options.now ?? Date.now;
  return {
    async call(request) {
      const startedAt = now();
      const attempted: string[] = [];
      const inputTokens = inputUpperBound(request.messages);
      let overBudget = false;
      for (const route of ROUTES[request.task_class]) {
        const provider = options.providers[route.provider];
        if (!provider || (!route.client_data_safe && !options.allowDemoModels)) continue;
        const worstCase = costUsd(route.price, inputTokens, request.budget.max_output);
        if (worstCase > request.budget.max_cost_usd) {
          overBudget = true;
          continue;
        }
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
        const usage: Usage = completion.usage
          ? { ...completion.usage, estimated: false }
          : {
              input_tokens: inputTokens,
              output_tokens: request.budget.max_output,
              estimated: true,
            };
        const measured = {
          model,
          usage,
          cost_usd: costUsd(route.price, usage.input_tokens, usage.output_tokens),
          latency_ms: now() - startedAt,
        };
        await options.recordUsage({
          ...measured,
          workspace: request.routing.workspace,
          trace: request.trace,
          task_class: request.task_class,
        });
        return { output: completion.text, ...measured };
      }
      if (attempted.length) throw new GatewayError("ALL_MODELS_FAILED", attempted);
      throw new GatewayError(overBudget ? "BUDGET_EXCEEDED" : "NO_MODEL_AVAILABLE", attempted);
    },
  };
}
