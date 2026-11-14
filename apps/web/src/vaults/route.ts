import { useEffect, useState } from "react";

export type Route =
  | { page: "list" }
  | { page: "vault"; vaultId: string; folderId: string | null }
  | { page: "bin"; vaultId: string }
  | { page: "admin" };

/** Hash routes, so the API's static server needs no rewrite rules. */
export function parseRoute(hash: string): Route | null {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "admin" && parts[1] === "vaults") return { page: "admin" };
  if (parts[0] !== "vaults") return null;
  const vaultId = parts[1];
  if (!vaultId) return { page: "list" };
  if (parts[2] === "bin") return { page: "bin", vaultId };
  return { page: "vault", vaultId, folderId: parts[2] === "folders" ? (parts[3] ?? null) : null };
}

export function routeHash(route: Route): string {
  switch (route.page) {
    case "list":
      return "#/vaults";
    case "admin":
      return "#/admin/vaults";
    case "bin":
      return `#/vaults/${encodeURIComponent(route.vaultId)}/bin`;
    case "vault":
      return route.folderId
        ? `#/vaults/${encodeURIComponent(route.vaultId)}/folders/${encodeURIComponent(route.folderId)}`
        : `#/vaults/${encodeURIComponent(route.vaultId)}`;
  }
}

export const go = (route: Route) => {
  window.location.hash = routeHash(route);
};

export function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return hash;
}
