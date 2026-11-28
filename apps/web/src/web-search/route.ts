export const webSearchRouteHash = () => "#/admin/web-search";

export function parseWebSearchRoute(hash: string): boolean {
  return hash.replace(/^#\/?/, "").split("?")[0] === "admin/web-search";
}
