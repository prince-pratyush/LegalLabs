// Runs one review against a local Ollama model; not part of CI.
// Usage: pnpm build && node scripts/smoke.mjs [model]
import { paraHash } from "@legallabs/contracts";
import { runReview, uuidv7 } from "../dist/index.js";

const model = process.argv[2] ?? "qwen3:4b-instruct";
const url = "http://localhost:11434/api/chat";

const texts = [
  ["1 Definitions", '"Confidential Information" means any information disclosed by either party.'],
  ["2 Confidentiality", "The Recipient shall keep Confidential Information secret for one year."],
  ["3 Liability", "The Supplier's liability under this Agreement is unlimited."],
  ["4 Payment", "The Customer shall pay each invoice within 90 days of receipt."],
  ["5 Governing law", "This Agreement is governed by the laws of England and Wales."],
];
const paragraphs = await Promise.all(
  texts.map(async ([section_path, text], index) => ({
    index,
    text,
    section_path,
    para_hash: await paraHash(text),
  })),
);
const rules = [
  {
    id: uuidv7(),
    ordinal: 0,
    title: "Confidentiality term",
    standard_position: "Confidentiality obligations last at least three years.",
    fallbacks: ["Two years for non-technical information."],
    flag: false,
    actions: [],
  },
  {
    id: uuidv7(),
    ordinal: 1,
    title: "Limitation of liability",
    standard_position: "Each party's liability is capped at the fees paid in the prior 12 months.",
    fallbacks: [],
    unacceptable: "Unlimited liability.",
    flag: true,
    actions: [],
  },
];

async function complete({ system, prompt, maxTokens, signal }) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      options: { num_ctx: 16384, num_predict: maxTokens, temperature: 0 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return {
    text: body.message?.content ?? "",
    model: body.model ?? model,
    usage: { input_tokens: body.prompt_eval_count ?? 0, output_tokens: body.eval_count ?? 0 },
    cost_usd: 0,
  };
}

const started = performance.now();
const outcome = await runReview(
  {
    paragraphs,
    existingEdits: [{ paragraph_index: 3, kind: "ins", text: "90 days", author: "Counterparty" }],
    rules,
    customisation: { party: "Acme (Customer)", paper: "theirs", mode: "standard", scope: "all" },
  },
  {
    complete,
    onEvent: (e) => console.error(`${((performance.now() - started) / 1000).toFixed(1)}s ${e.type}`),
  },
);
console.log(JSON.stringify(outcome, null, 2));
console.error(`done in ${((performance.now() - started) / 1000).toFixed(1)}s`);
