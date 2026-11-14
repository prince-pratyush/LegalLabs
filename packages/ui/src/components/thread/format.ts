const counts = new Intl.NumberFormat("en-US");

export const formatCount = (n: number) => counts.format(n);

/** Four places, because a small model's answer can cost a fraction of a cent. */
export function formatCost(usd: number | null | undefined, local = false): string {
  if (usd === null || usd === undefined) return "cost unknown";
  if (usd === 0 && local) return "free";
  return `$${usd.toFixed(4)}`;
}

/** Local models run on the firm's own hardware, so they cost nothing per token. */
export const isLocalModel = (model: string | null) =>
  model !== null && /^(ollama|local|vllm)\//.test(model);
