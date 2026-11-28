export const usersHash = () => "#/admin/users";

export function parseUsersRoute(hash: string): boolean {
  return hash.replace(/^#\/?/, "").split("?")[0] === "admin/users";
}
