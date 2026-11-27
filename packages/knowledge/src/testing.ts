import { type Http, NotFound } from "./http.js";
import type { AuthorityRecord } from "./record.js";
import type { Loader, LoadFailure } from "./sources.js";

/** Canned answers by URL prefix; anything else is a 404, as a missing file would be. */
export function fakeHttp(routes: Record<string, unknown>, seen: string[] = []): Http {
  const find = (url: string) => {
    seen.push(url);
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (key === undefined) throw new NotFound(url);
    return routes[key];
  };
  return {
    text: async (url) => {
      const body = find(url);
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    json: async (url) => find(url),
  };
}

export async function collect(loader: Loader) {
  const items: (AuthorityRecord | LoadFailure)[] = [];
  for await (const item of loader.records()) items.push(item);
  return items;
}
