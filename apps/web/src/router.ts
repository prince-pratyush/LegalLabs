import { type CitationTarget, parseCitationPath } from "@legallabs/contracts";
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "new" }
  | { name: "thread"; id: string }
  | { name: "history" }
  | { name: "viewer"; target: CitationTarget; path: string }
  | { name: "missing" };

/** Reads a location hash such as `#/t/123`; anything unknown is "missing", not a crash. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  if (path === "/") return { name: "new" };
  if (path === "/history") return { name: "history" };
  const thread = /^\/t\/([^/?#]+)$/.exec(path);
  if (thread?.[1]) return { name: "thread", id: decodeURIComponent(thread[1]) };
  if (path.startsWith("/d/")) {
    const target = parseCitationPath(path);
    if (target) return { name: "viewer", target, path };
  }
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

const subscribe = (notify: () => void) => {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
};

export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}
