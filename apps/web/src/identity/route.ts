export const identityHash = () => "#/admin/identity";

export function parseIdentityRoute(hash: string): boolean {
  return hash.replace(/^#\/?/, "").split("?")[0] === "admin/identity";
}
