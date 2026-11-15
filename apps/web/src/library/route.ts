export type LibraryTab = "prompts" | "templates" | "playbooks" | "workflows";

const TABS: readonly LibraryTab[] = ["prompts", "templates", "playbooks", "workflows"];

/** `#/library` and `#/library/<tab>`; anything else isn't the Library. */
export function parseLibraryRoute(hash: string): { tab: LibraryTab } | null {
  const [page, tab] = hash.replace(/^#\/?/, "").split("/");
  if (page !== "library") return null;
  return { tab: TABS.includes(tab as LibraryTab) ? (tab as LibraryTab) : "prompts" };
}

export const libraryHash = (tab: LibraryTab = "prompts") => `#/library/${tab}`;
