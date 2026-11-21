export type AgentTab = "instructions" | "versions" | "changes" | "activity";

export type AgentRoute =
  | { page: "list" }
  | { page: "agent"; agentId: string; tab: AgentTab }
  | { page: "build"; agentId: string }
  | { page: "test"; agentId: string; version: string | null }
  | { page: "run"; agentId: string; runId: string }
  | { page: "requests" }
  | { page: "approvals" };

const TABS: readonly AgentTab[] = ["versions", "changes", "activity"];

/** Hash routes, like the other pages, so the API's static server needs no rewrites. */
export function parseAgentRoute(hash: string): AgentRoute | null {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "admin" && parts[1] === "sharing") {
    if (parts[2] === "requests") return { page: "requests" };
    if (parts[2] === "approvals") return { page: "approvals" };
    return null;
  }
  if (parts[0] !== "agents") return null;
  const agentId = parts[1];
  if (!agentId) return { page: "list" };
  const sub = parts[2];
  if (sub === "build") return { page: "build", agentId };
  if (sub === "test") {
    return { page: "test", agentId, version: new URLSearchParams(query).get("version") };
  }
  if (sub === "runs" && parts[3]) return { page: "run", agentId, runId: parts[3] };
  const tab = TABS.find((t) => t === sub) ?? "instructions";
  return { page: "agent", agentId, tab };
}

export function agentHash(route: AgentRoute): string {
  const e = encodeURIComponent;
  switch (route.page) {
    case "list":
      return "#/agents";
    case "agent":
      return `#/agents/${e(route.agentId)}${route.tab === "instructions" ? "" : `/${route.tab}`}`;
    case "build":
      return `#/agents/${e(route.agentId)}/build`;
    case "test":
      return `#/agents/${e(route.agentId)}/test${route.version ? `?version=${e(route.version)}` : ""}`;
    case "run":
      return `#/agents/${e(route.agentId)}/runs/${e(route.runId)}`;
    case "requests":
      return "#/admin/sharing/requests";
    case "approvals":
      return "#/admin/sharing/approvals";
  }
}

export const goAgents = (route: AgentRoute) => {
  window.location.hash = agentHash(route);
};

/** The test thread opens beside the editor, so both can be watched at once. */
export const openTest = (agentId: string, version: string | null) => {
  const url = `${window.location.pathname}${window.location.search}${agentHash({ page: "test", agentId, version })}`;
  window.open(url, "_blank", "noopener");
};

/** Cross-tab news: the test tab tells the editor tab that the draft changed. */
export const DRAFT_CHANNEL = "legallabs-agent-drafts";
export type DraftNews = { agentId: string; draftVersionId: string };

export function announceDraft(news: DraftNews) {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(DRAFT_CHANNEL);
  channel.postMessage(news);
  channel.close();
}

export function listenForDrafts(onNews: (news: DraftNews) => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(DRAFT_CHANNEL);
  channel.onmessage = (event: MessageEvent<DraftNews>) => {
    const data = event.data;
    if (data && typeof data.agentId === "string" && typeof data.draftVersionId === "string")
      onNews(data);
  };
  return () => channel.close();
}
