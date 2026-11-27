import type {
  CiAgent,
  CiAgentCreate,
  CiDashboard,
  CiReview,
  CiReviewCreate,
} from "@legallabs/contracts";
import { request, send } from "../http.js";

const e = encodeURIComponent;
const agentPath = (id: string) => `/apps/ci/agents/${e(id)}`;
const reviewPath = (id: string) => `/apps/ci/reviews/${e(id)}`;

export interface QueueFilter {
  status?: string;
  agentId?: string;
  /** A user id, or "me". */
  assigneeId?: string;
  counterparty?: string;
  from?: string;
  to?: string;
}

const PARAMS = {
  status: "filter[status]",
  agentId: "filter[agent_id]",
  assigneeId: "filter[assignee_id]",
  counterparty: "filter[counterparty]",
  from: "filter[from]",
  to: "filter[to]",
} as const;

export const ciApi = {
  dashboard: (since: string | null) =>
    request<CiDashboard>(`/apps/ci/dashboard${since ? `?since=${e(since)}` : ""}`),
  reviews: (filter: QueueFilter, cursor?: string) => {
    const query = new URLSearchParams();
    for (const [key, name] of Object.entries(PARAMS)) {
      const value = filter[key as keyof QueueFilter];
      if (value) query.set(name, value);
    }
    if (cursor) query.set("cursor", cursor);
    return request<{ reviews: CiReview[]; next_cursor: string | null }>(
      `/apps/ci/reviews?${query}`,
    );
  },
  review: async (id: string) => (await request<{ review: CiReview }>(reviewPath(id))).review,
  submit: (input: CiReviewCreate) => send<{ review_id: string }>("POST", "/apps/ci/reviews", input),
  assign: async (id: string, assigneeId: string) =>
    (
      await send<{ review: CiReview }>("POST", `${reviewPath(id)}/assign`, {
        assignee_id: assigneeId,
      })
    ).review,
  markDone: async (id: string) =>
    (await send<{ review: CiReview }>("POST", `${reviewPath(id)}/status`, { status: "done" }))
      .review,
  rerun: (id: string) => send<{ review_id: string }>("POST", `${reviewPath(id)}/rerun`),

  agents: async () => (await request<{ agents: CiAgent[] }>("/apps/ci/agents")).agents,
  agent: (id: string) => request<{ agent: CiAgent; names: Record<string, string> }>(agentPath(id)),
  createAgent: async (input: CiAgentCreate) =>
    (await send<{ agent: CiAgent }>("POST", "/apps/ci/agents", input)).agent,
  updateAgent: async (id: string, patch: CiAgentCreate) =>
    (await send<{ agent: CiAgent }>("PATCH", agentPath(id), patch)).agent,
  setLive: async (id: string, live: boolean) =>
    (await send<{ agent: CiAgent }>("POST", `${agentPath(id)}/${live ? "activate" : "deactivate"}`))
      .agent,
};
