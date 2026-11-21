export type TableRoute =
  | { page: "list"; threadId: string | null }
  | { page: "table"; tableId: string };

/** #/tables, #/tables?thread={id} (opens Create from that thread), #/tables/{id}. */
export function parseTableRoute(hash: string): TableRoute | null {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "tables") return null;
  if (parts[1]) return { page: "table", tableId: parts[1] };
  return { page: "list", threadId: new URLSearchParams(query).get("thread") || null };
}

export function tableHash(route: TableRoute): string {
  if (route.page === "table") return `#/tables/${encodeURIComponent(route.tableId)}`;
  return route.threadId ? `#/tables?thread=${encodeURIComponent(route.threadId)}` : "#/tables";
}

export const goTables = (route: TableRoute) => {
  window.location.hash = tableHash(route);
};
