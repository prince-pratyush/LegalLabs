import type {
  IntakeEvent,
  IntakeMine,
  IntakeRequest,
  IntakeRequestDetail,
  IntakeStatusChange,
  IntakeType,
  IntakeTypeCreate,
} from "@legallabs/contracts";
import { request, send } from "../http.js";

const e = encodeURIComponent;
const requestPath = (id: string) => `/apps/intake/requests/${e(id)}`;
const typePath = (id: string) => `/apps/intake/request-types/${e(id)}`;

export interface QueueFilter {
  status: string;
  typeId: string;
  channel: string;
  /** "me" or empty for anyone. */
  assigneeId: string;
}

const PARAMS: Record<keyof QueueFilter, string> = {
  status: "filter[status]",
  typeId: "filter[type_id]",
  channel: "filter[channel]",
  assigneeId: "filter[assignee_id]",
};

const change = async (id: string, action: string, body: unknown) =>
  (await send<{ request: IntakeRequestDetail }>("POST", `${requestPath(id)}/${action}`, body))
    .request;

export const intakeApi = {
  requests: (filter: QueueFilter, cursor?: string) => {
    const query = new URLSearchParams();
    for (const [key, name] of Object.entries(PARAMS)) {
      const value = filter[key as keyof QueueFilter];
      if (value) query.set(name, value);
    }
    if (cursor) query.set("cursor", cursor);
    return request<{ requests: IntakeRequest[]; next_cursor: string | null }>(
      `/apps/intake/requests?${query}`,
    );
  },
  request: async (id: string) =>
    (await request<{ request: IntakeRequestDetail }>(requestPath(id))).request,
  events: async (id: string) =>
    (await request<{ events: IntakeEvent[] }>(`${requestPath(id)}/audit`)).events,
  assignees: async (id: string) =>
    (await request<{ people: { id: string; name: string }[] }>(`${requestPath(id)}/assignees`))
      .people,
  assign: (id: string, assigneeId: string | null) =>
    change(id, "assign", { assignee_id: assigneeId }),
  setType: (id: string, typeId: string) => change(id, "type", { type_id: typeId }),
  setStatus: (id: string, status: IntakeStatusChange) => change(id, "status", status),
  reply: (id: string, text: string) =>
    send<{ delivery: "queued" }>("POST", `${requestPath(id)}/reply`, { text }),
  mine: () => request<IntakeMine>("/apps/intake/my-tasks"),

  types: () => request<{ types: IntakeType[]; can_manage: boolean }>("/apps/intake/request-types"),
  createType: (input: IntakeTypeCreate) =>
    send<{ type: IntakeType }>("POST", "/apps/intake/request-types", input),
  updateType: (id: string, patch: IntakeTypeCreate) =>
    send<{ type: IntakeType }>("PATCH", typePath(id), patch),
  removeType: (id: string) => send<null>("DELETE", typePath(id)),
};
