/** A web search service, as the rest of the platform sees it. */

export interface SearchResult {
  /** https only. */
  url: string;
  title: string;
  snippet: string;
  publishedAt?: string;
}

export interface SearchOptions {
  limit: number;
  recencyDays?: number;
  signal?: AbortSignal;
}

export interface WebSearchProvider {
  readonly name: string;
  /** The host queries are sent to, so people can be told. */
  readonly host: string;
  /** Throws when the service cannot answer; the error never repeats the query. */
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}
