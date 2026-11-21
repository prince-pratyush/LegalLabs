import type { Block, RoutingClass } from "@legallabs/contracts";

// A deterministic first cut of the prompt classifier (04-ai-design.md): plan-time checks and
// retries must reach the same class, so this never asks a model.
const RULES: [RoutingClass, RegExp][] = [
  ["summarise", /\b(summari[sz]e|summary|overview|key points|digest|synthesi[sz]e)/i],
  ["draft", /\b(draft|write|prepare|compose|translate|rewrite|redraft)/i],
  ["extract", /\b(extract|list|identify|find|pull out|locate|tabulate|transcribe)/i],
];

export function classifyPrompt(prompt: string): RoutingClass {
  return RULES.find(([, re]) => re.test(prompt))?.[0] ?? "reason";
}

/** The class each kind of model-calling block routes by; null for blocks that call none. */
export function routingClassOf(block: Block): RoutingClass | null {
  switch (block.type) {
    case "ai_action":
      return classifyPrompt(block.prompt);
    case "drafting":
      return "draft";
    case "review_table.generate":
      return "extract";
    default:
      return null;
  }
}
