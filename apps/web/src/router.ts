import { useSyncExternalStore } from "react";

export type Route =
  | { name: "new" }
  | { name: "thread"; id: string }
  | { name: "history" }
  | { name: "missing" };

/**
 * Reads a location hash such as `#/t/123`; anything unknown is "missing", not a crash.
 * Documents open on real paths (`/d/...`) in the viewer, over whichever screen this shows.
 */
export function parseRoute(hash: string): Route {
  // A query (e.g. from a shared link) doesn't change which screen it is.
  const path = hash.replace(/^#/, "").split("?")[0] || "/";
  if (path === "/") return { name: "new" };
  if (path === "/history") return { name: "history" };
  const thread = /^\/t\/([^/?#]+)$/.exec(path);
  if (thread?.[1]) return { name: "thread", id: decodeURIComponent(thread[1]) };
  return { name: "missing" };
}

export const paths = {
  new: "/",
  history: "/history",
  thread: (id: string) => `/t/${encodeURIComponent(id)}`,
};

export function navigate(path: string) {
  window.location.hash = path;
}

// Back from the document viewer is a history step across paths, which fires popstate, not hashchange.
const subscribe = (notify: () => void) => {
  window.addEventListener("hashchange", notify);
  window.addEventListener("popstate", notify);
  return () => {
    window.removeEventListener("hashchange", notify);
    window.removeEventListener("popstate", notify);
  };
};

export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}
