import type { SearchResult, WebSearchProvider } from "./port.js";

/** A search provider for tests: answers from a list and records what it was asked. */
export function createFakeSearch(
  results: readonly SearchResult[] | ((query: string) => readonly SearchResult[]),
): WebSearchProvider & { queries: string[] } {
  const queries: string[] = [];
  return {
    name: "fake",
    host: "search.invalid",
    queries,
    async search(query, { limit }) {
      queries.push(query);
      return (typeof results === "function" ? results(query) : results).slice(0, limit);
    },
  };
}
