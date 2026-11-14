import { costUsd, type ProviderId, ROUTES, type Route, type TaskClass } from "./routes.js";

export type Message = { role: "system" | "user" | "assistant"; content: string };

export type Completion = {
  text: string;
  usage?: { input_tokens: number; output_tokens: number };
};

type ProviderRequest = {
  model: string;
  messages: readonly Message[];
  max_output: number;
  signal?: AbortSignal;
};

export type ModelProvider = {
  complete(request: ProviderRequest): Promise<Completion>;
  /** Optional: providers without it are streamed as one chunk. */
  stream?(request: ProviderRequest, onText: (delta: string) => void): Promise<Completion>;
};

export type Usage = { input_tokens: number; output_tokens: number; estimated: boolean };

export type GatewayCall = {
  task_class: TaskClass;
  messages: readonly Message[];
  budget: { max_output: number; max_cost_usd: number };
  routing: { workspace: string };
  trace: string;
  /** "provider/model" the user picked; tried first, others only as fallback. */
  model?: string;
};

type Measured = { model: string; usage: Usage; cost_usd: number; latency_ms: number };

export type GatewayResult = Measured & {
  output: string;
  requested_model: string | null;
  fallback: boolean;
};

export type UsageRecord = Measured & { workspace: string; trace: string; task_class: TaskClass };

export type ModelInfo = {
  id: string;
  context_window: number;
  free: boolean;
  /** US dollars per million tokens, so callers can estimate a run before it starts. */
  price: { input: number; output: number };
};

export type Gateway = {
  call(request: GatewayCall): Promise<GatewayResult>;
  /** A signal stops the model, so a cancelled answer stops costing. */
  stream(
    request: GatewayCall,
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<GatewayResult>;
  /** Models this install can actually use for a task, in routing order. */
  models(task_class: TaskClass): ModelInfo[];
  /** The smallest window among usable models, so a prompt sized to it fits any of them. */
  contextTokens(task_class: TaskClass): number;
};

export type GatewayOptions = {
  providers: Partial<Record<ProviderId, ModelProvider>>;
  allowDemoModels?: boolean;
  /** Windows the install configured, such as a raised Ollama context length. */
  contextWindows?: Partial<Record<ProviderId, number>>;
  recordUsage: (record: UsageRecord) => Promise<void>;
  now?: () => number;
};

export type GatewayErrorCode =
  | "NO_MODEL_AVAILABLE"
  | "BUDGET_EXCEEDED"
  | "ALL_MODELS_FAILED"
  | "MODEL_NOT_ALLOWED"
  | "STREAM_INTERRUPTED";

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    readonly attempted: readonly string[],
  ) {
    super(`${code}: ${attempted.join(", ") || "no models tried"}`);
    this.name = "GatewayError";
  }
}

const MESSAGE_OVERHEAD_TOKENS = 16;
const FALLBACK_CONTEXT = 4_096;
const encoder = new TextEncoder();

// A token covers at least a byte, so counting bytes cannot under-count.
function inputUpperBound(messages: readonly Message[]): number {
  return messages.reduce(
    (total, message) => total + MESSAGE_OVERHEAD_TOKENS + encoder.encode(message.content).length,
    0,
  );
}

const idOf = (route: Route) => `${route.provider}/${route.model}`;

export function createGateway(options: GatewayOptions): Gateway {
  const now = options.now ?? Date.now;

  const usable = (taskClass: TaskClass) =>
    ROUTES[taskClass].filter(
      (route) =>
        options.providers[route.provider] !== undefined &&
        (route.client_data_safe || options.allowDemoModels === true),
    );

  const windowOf = (route: Route) =>
    options.contextWindows?.[route.provider] ?? route.context_window;

  function ordered(request: GatewayCall): Route[] {
    const routes = usable(request.task_class);
    if (request.model === undefined) return routes;
    const chosen = routes.find((route) => idOf(route) === request.model);
    // A model the install can't use is refused, never quietly swapped.
    if (!chosen) throw new GatewayError("MODEL_NOT_ALLOWED", []);
    return [chosen, ...routes.filter((route) => route !== chosen)];
  }

  async function run(
    request: GatewayCall,
    attempt: (provider: ModelProvider, providerRequest: ProviderRequest) => Promise<Completion>,
    started: () => boolean,
  ): Promise<GatewayResult> {
    const startedAt = now();
    const attempted: string[] = [];
    const inputTokens = inputUpperBound(request.messages);
    let remainingUsd = request.budget.max_cost_usd;
    let overBudget = false;
    for (const route of ordered(request)) {
      const provider = options.providers[route.provider];
      if (!provider) continue;
      const worstCase = costUsd(route.price, inputTokens, request.budget.max_output);
      // Written this way round so a NaN cap refuses instead of passing.
      if (!(worstCase <= remainingUsd)) {
        overBudget = true;
        continue;
      }
      const model = idOf(route);
      let completion: Completion;
      try {
        completion = await attempt(provider, {
          model: route.model,
          messages: request.messages,
          max_output: request.budget.max_output,
        });
      } catch {
        // The provider's error is dropped because it can quote the prompt.
        attempted.push(model);
        // A failed attempt may still be billed, so assume it was.
        remainingUsd -= worstCase;
        // Text already shown can't be taken back, so a half-streamed answer stops here.
        if (started()) throw new GatewayError("STREAM_INTERRUPTED", attempted);
        continue;
      }
      const usage: Usage = completion.usage
        ? { ...completion.usage, estimated: false }
        : { input_tokens: inputTokens, output_tokens: request.budget.max_output, estimated: true };
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
      return {
        output: completion.text,
        ...measured,
        requested_model: request.model ?? null,
        fallback: request.model !== undefined && request.model !== model,
      };
    }
    if (attempted.length) throw new GatewayError("ALL_MODELS_FAILED", attempted);
    throw new GatewayError(overBudget ? "BUDGET_EXCEEDED" : "NO_MODEL_AVAILABLE", attempted);
  }

  return {
    call: (request) =>
      run(
        request,
        (provider, providerRequest) => provider.complete(providerRequest),
        () => false,
      ),

    stream(request, onText, signal) {
      let started = false;
      const emit = (delta: string) => {
        if (delta === "") return;
        started = true;
        onText(delta);
      };
      return run(
        request,
        async (provider, providerRequest) => {
          if (signal?.aborted) throw new Error("aborted");
          const withSignal = signal ? { ...providerRequest, signal } : providerRequest;
          if (provider.stream) return provider.stream(withSignal, emit);
          const completion = await provider.complete(providerRequest);
          emit(completion.text);
          return completion;
        },
        // A cancelled answer must not fall back to another model either.
        () => started || signal?.aborted === true,
      );
    },

    models: (taskClass) =>
      usable(taskClass).map((route) => ({
        id: idOf(route),
        context_window: windowOf(route),
        free: route.price.input === 0 && route.price.output === 0,
        price: { input: route.price.input, output: route.price.output },
      })),

    contextTokens(taskClass) {
      const windows = usable(taskClass).map(windowOf);
      return windows.length ? Math.min(...windows) : FALLBACK_CONTEXT;
    },
  };
}
