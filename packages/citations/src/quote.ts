export interface Located {
  from: number;
  to: number;
  text: string;
  exact: boolean;
}

export type QuoteResult = { found: true; located: Located } | { found: false };

export function locateQuote(page: string, quote: string): QuoteResult {
  const from = page.indexOf(quote);
  if (from < 0) return { found: false };
  const to = from + quote.length;
  return { found: true, located: { from, to, text: page.slice(from, to), exact: true } };
}
