export type MattersTab = "matters" | "walls";

/** `#/admin/matters` and `#/admin/matters/walls`; anything else isn't Matters & Walls. */
export function parseMattersRoute(hash: string): { tab: MattersTab } | null {
  const [admin, page, tab] = hash.replace(/^#\/?/, "").split("?")[0]?.split("/") ?? [];
  if (admin !== "admin" || page !== "matters") return null;
  return { tab: tab === "walls" ? "walls" : "matters" };
}

export const mattersHash = (tab: MattersTab = "matters") =>
  tab === "walls" ? "#/admin/matters/walls" : "#/admin/matters";
