import { createGateway, gatewayOptionsFromEnv, type TaskClass } from "@legallabs/model-gateway";
import type { CompleteCall, CompleteResult } from "@legallabs/review";

export type Complete = (call: CompleteCall) => Promise<CompleteResult>;
export type ClientName = "fake" | "ollama" | "gateway" | "anthropic" | "openai";
export const CLIENTS: readonly ClientName[] = ["fake", "ollama", "gateway", "anthropic", "openai"];

export type ClientOptions = {
  client: ClientName;
  model?: string | undefined;
  /** Hard stop for one call, on top of the engine's per-rule budget. */
  callTimeoutMs?: number;
  ollamaUrl?: string;
  /** Ollama context window; the default 4k cuts the longest prompts. */
  numCtx?: number;
  /** Ollama sampling seed, fixed so a rerun at temperature 0 is reproducible. */
  seed?: number;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
};

const DEFAULT_MODELS: Record<ClientName, string> = {
  fake: "fake",
  ollama: "qwen3:4b-instruct",
  gateway: "anthropic/claude-haiku-5-5",
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-5.5",
};

// About four characters a token in English; only the fake client estimates.
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const withTimeout = (signal: AbortSignal | undefined, ms: number) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

/** The last few words of the first paragraph line, which verifyQuote always finds. */
function firstQuote(prompt: string): { p: number; quote: string } | null {
  const line = /^\[P?(\d+)\][^\n]*$/m.exec(prompt.split(/<doc-[a-z0-9]+>/i).at(-1) ?? "");
  if (!line) return null;
  const words = line[0].split(/\s+/).slice(-6).join(" ");
  return { p: Number(line[1]), quote: words };
}

let fakeTurn = 0;
/**
 * Offline and deterministic: valid JSON in every shape the engine asks for, so CI proves
 * the pipeline runs end to end. Its scores measure nothing about review quality.
 */
export function fakeComplete(call: CompleteCall): CompleteResult {
  let text = "{}";
  if (call.task === "verify") text = '{"gaps":[]}';
  if (call.task === "draft") {
    const q = firstQuote(call.prompt);
    const statuses = ["acceptable", "needs_review", "not_acceptable"] as const;
    const status = q ? statuses[fakeTurn++ % 3] : "not_found";
    text = JSON.stringify({
      status,
      matched: status === "acceptable" ? "standard" : "none",
      fallback: null,
      evidence: q ? [q] : [],
      explanation: "Recorded reply.",
      suggestion:
        status === "not_acceptable" && q
          ? { p: q.p, before: q.quote, after: `${q.quote} (amended)` }
          : null,
    });
  }
  return {
    text,
    model: "fake",
    usage: {
      input_tokens: estimateTokens(call.system + call.prompt),
      output_tokens: estimateTokens(text),
    },
    cost_usd: 0,
  };
}

const TASK_CLASS: Record<CompleteCall["task"], TaskClass> = {
  extract: "read_extract",
  draft: "draft_edit",
  verify: "read_extract",
};

export function makeClient(opts: ClientOptions): { complete: Complete; model: string } {
  const model = opts.model ?? DEFAULT_MODELS[opts.client];
  const env = opts.env ?? process.env;
  const http = opts.fetch ?? fetch;
  const timeout = opts.callTimeoutMs ?? 300_000;
  const post = async (
    url: string,
    headers: Record<string, string>,
    body: unknown,
    s?: AbortSignal,
  ) => {
    const res = await http(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: withTimeout(s, timeout),
    });
    // The body can echo the prompt, so only the status is reported.
    if (!res.ok) throw new Error(`${opts.client} returned ${res.status}`);
    return (await res.json()) as Record<string, never>;
  };

  switch (opts.client) {
    case "fake":
      return { model, complete: async (call) => fakeComplete(call) };

    case "ollama": {
      const url = `${opts.ollamaUrl ?? env.OLLAMA_BASE_URL ?? "http://localhost:11434"}/api/chat`;
      return {
        model,
        complete: async ({ system, prompt, maxTokens, signal }) => {
          const body: {
            model?: string;
            message?: { content?: string };
            prompt_eval_count?: number;
            eval_count?: number;
          } = await post(
            url,
            {},
            {
              model,
              stream: false,
              format: "json",
              options: {
                num_ctx: opts.numCtx ?? 8192,
                num_predict: maxTokens,
                temperature: 0,
                seed: opts.seed ?? 0,
              },
              messages: [
                { role: "system", content: system },
                { role: "user", content: prompt },
              ],
            },
            signal,
          );
          return {
            text: body.message?.content ?? "",
            // The model that answered, which run.ts checks against the pinned one.
            model: body.model ?? "",
            usage: {
              input_tokens: body.prompt_eval_count ?? 0,
              output_tokens: body.eval_count ?? 0,
            },
            cost_usd: 0,
          };
        },
      };
    }

    case "gateway": {
      // Only providers with keys in the environment are configured, so nothing else is billed.
      const gateway = createGateway({
        ...gatewayOptionsFromEnv(env),
        recordUsage: async () => {},
      });
      return {
        model,
        complete: async ({ task, system, prompt, maxTokens, signal }) => {
          const r = await gateway.call(
            {
              task_class: TASK_CLASS[task],
              messages: [
                { role: "system", content: system },
                { role: "user", content: prompt },
              ],
              budget: { max_output: maxTokens, max_cost_usd: 1 },
              routing: { workspace: "eval", user: null },
              trace: "playbook-review",
              model,
            },
            withTimeout(signal, timeout),
          );
          return {
            text: r.output,
            model: r.model,
            usage: { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens },
            cost_usd: r.cost_usd,
          };
        },
      };
    }

    case "anthropic": {
      const key = env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
      return {
        model,
        complete: async ({ system, prompt, maxTokens, signal }) => {
          const body: {
            model?: string;
            content?: { text?: string }[];
            usage?: { input_tokens?: number; output_tokens?: number };
          } = await post(
            "https://api.anthropic.com/v1/messages",
            { "x-api-key": key, "anthropic-version": "2023-06-01" },
            {
              model,
              max_tokens: maxTokens,
              temperature: 0,
              system,
              messages: [{ role: "user", content: prompt }],
            },
            signal,
          );
          return {
            text: (body.content ?? []).map((b) => b.text ?? "").join(""),
            model: body.model ?? "",
            usage: {
              input_tokens: body.usage?.input_tokens ?? 0,
              output_tokens: body.usage?.output_tokens ?? 0,
            },
            // Priced from tokens by the Python suite, which owns the price table.
            cost_usd: 0,
          };
        },
      };
    }

    case "openai": {
      const key = env.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY is not set");
      return {
        model,
        complete: async ({ system, prompt, maxTokens, signal }) => {
          const body: {
            model?: string;
            choices?: { message?: { content?: string | null } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          } = await post(
            "https://api.openai.com/v1/chat/completions",
            { authorization: `Bearer ${key}` },
            {
              model,
              max_completion_tokens: maxTokens,
              temperature: 0,
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: system },
                { role: "user", content: prompt },
              ],
            },
            signal,
          );
          return {
            text: body.choices?.[0]?.message?.content ?? "",
            model: body.model ?? "",
            usage: {
              input_tokens: body.usage?.prompt_tokens ?? 0,
              output_tokens: body.usage?.completion_tokens ?? 0,
            },
            cost_usd: 0,
          };
        },
      };
    }
  }
}

/**
 * True when the answering model is the pinned one: the gateway's "provider/" prefix and a
 * provider's dated snapshot suffix (claude-x-20261101, gpt-x-2026-11-01) are allowed.
 */
export function sameModel(pinned: string, answered: string): boolean {
  const base = (m: string) => m.split("/").at(-1) ?? m;
  const p = base(pinned);
  const a = base(answered);
  return (
    a === p ||
    new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{4}-?\\d{2}-?\\d{2}$`).test(a)
  );
}
