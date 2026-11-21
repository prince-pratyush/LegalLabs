export type TableRoute =
  | { page: "list"; threadId: string | null; templateId?: string | null }
  | { page: "templates" }
  | { page: "table"; tableId: string };

/**
 * #/tables, #/tables?thread={id} (opens Create from that thread), #/tables?template={id}
 * (opens Create from that template), #/tables/templates, #/tables/{id}.
 */
export function parseTableRoute(hash: string): TableRoute | null {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "tables") return null;
  if (parts[1] === "templates") return { page: "templates" };
  if (parts[1]) return { page: "table", tableId: parts[1] };
  const params = new URLSearchParams(query);
  return {
    page: "list",
    threadId: params.get("thread") || null,
    templateId: params.get("template") || null,
  };
}

export function tableHash(route: TableRoute): string {
  if (route.page === "table") return `#/tables/${encodeURIComponent(route.tableId)}`;
  if (route.page === "templates") return "#/tables/templates";
  if (route.templateId) return `#/tables?template=${encodeURIComponent(route.templateId)}`;
  return route.threadId ? `#/tables?thread=${encodeURIComponent(route.threadId)}` : "#/tables";
}

export const goTables = (route: TableRoute) => {
  window.location.hash = tableHash(route);
};
