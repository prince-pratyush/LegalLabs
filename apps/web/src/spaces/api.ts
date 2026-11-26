import { ApiError } from "../api.js";

export interface Space {
  id: string;
  name: string;
  kind: "internal" | "external";
  matter: { id: string; display: string } | null;
  context: {
    version: number;
    summary?: string;
    parties: { name: string; role: string; counsel?: string }[];
    key_dates: { label: string; date: string }[];
    standing_instructions?: string;
  };
  customization: { accent_color?: string; welcome_md?: string; agent_runs_interactive?: boolean };
  my_role: "admin" | "collaborator";
  counts: { members: number; resources: number; open_tasks: number };
  created_at: string;
}

export interface DirectoryEntry {
  id: string;
  name: string;
  matter_id: string | null;
  locked: boolean;
}

export interface Member {
  id: string;
  principal_type: "user" | "group";
  principal_id: string;
  label: string | null;
  role: "admin" | "collaborator";
}

export interface Resource {
  id: string;
  resource_type: string;
  resource_id: string;
  name: string | null;
  access: string;
  /** Guest party id to level, in an external Space. */
  per_party?: Record<string, string>;
}

export interface Party {
  id: string;
  name: string;
  domain: string;
  connection_admin_emails: string[];
  connection: {
    status: "action_required" | "in_progress" | "resolved" | "rejected";
    approvals: { side: "internal" | "external"; at: string }[];
  };
}

export interface Guest {
  user_id: string;
  email: string;
  name: string;
  expires_at: string;
  status: "active" | "expired" | "deactivated";
}

export interface ShareRequest {
  id: string;
  name: string;
  access: string;
  per_party: Record<string, string>;
  requester_name: string;
}

export interface Phase {
  id: string;
  ordinal: number;
  name: string;
  locked: boolean;
  gate_pending: number;
}

export type Assignee =
  | { type: "user"; user_id: string }
  | { type: "assistant" }
  | { type: "agent"; agent_id: string };

export type TaskStatus = "todo" | "in_progress" | "done" | "cancelled";

export interface Task {
  id: string;
  space_id: string;
  phase_id: string | null;
  name: string;
  description_md: string;
  assignee: Assignee | null;
  due_at: string | null;
  status: TaskStatus;
  awaiting_approval: boolean;
  locked: boolean;
  gate: boolean;
  run: { id: string; status: string; thread_id: string | null } | null;
  comments_count: number;
}

export interface Comment {
  id: string;
  author_type: "user" | "assistant";
  author_name: string | null;
  body_md: string | null;
  deleted: boolean;
  created_at: string;
}

export interface Activity {
  id: string;
  type: string;
  actor_name: string | null;
  actor_type: string;
  at: string;
}

const FALLBACK = "Something went wrong. Try again.";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const json = typeof init.body === "string";
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "same-origin",
    headers: json ? { "content-type": "application/json" } : {},
  });
  const text = await res.text();
  const body = (text ? JSON.parse(text) : null) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(body?.code ?? "UNKNOWN"),
      typeof body?.message === "string" ? body.message : FALLBACK,
    );
  }
  return body as T;
}

const send = <T>(method: string, path: string, body?: unknown) =>
  call<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const enc = encodeURIComponent;

export const spacesApi = {
  list: async () => (await call<{ spaces: Space[] }>("/spaces?filter[member]=me")).spaces,
  directory: async () => (await call<{ spaces: DirectoryEntry[] }>("/spaces/directory")).spaces,
  create: async (name: string, kind: Space["kind"] = "internal") =>
    (await send<{ space: Space }>("POST", "/spaces", { name, kind })).space,
  get: async (id: string) => (await call<{ space: Space }>(`/spaces/${enc(id)}`)).space,
  setContext: async (id: string, context: Omit<Space["context"], "version">) =>
    (await send<{ space: Space }>("PUT", `/spaces/${enc(id)}/context`, context)).space,
  requestAccess: (id: string) => send<unknown>("POST", `/spaces/${enc(id)}/access-requests`, {}),

  members: async (id: string) =>
    (await call<{ members: Member[] }>(`/spaces/${enc(id)}/members`)).members,
  resources: async (id: string) =>
    (await call<{ resources: Resource[] }>(`/spaces/${enc(id)}/resources`)).resources,
  activity: async (id: string) =>
    (await call<{ items: Activity[] }>(`/spaces/${enc(id)}/activity`)).items,

  parties: async (id: string) =>
    (await call<{ parties: Party[] }>(`/spaces/${enc(id)}/parties`)).parties,
  addParty: (
    id: string,
    input: { name: string; domain: string; connection_admin_emails: string[] },
  ) => send<unknown>("POST", `/spaces/${enc(id)}/parties`, input),
  removeParty: (id: string, partyId: string) =>
    send<unknown>("DELETE", `/spaces/${enc(id)}/parties/${enc(partyId)}`),
  approveParty: (id: string, partyId: string) =>
    send<unknown>("POST", `/spaces/${enc(id)}/parties/${enc(partyId)}/approve`),
  rejectParty: (id: string, partyId: string) =>
    send<unknown>("POST", `/spaces/${enc(id)}/parties/${enc(partyId)}/reject`, {}),
  guests: async (id: string) =>
    (await call<{ guests: Guest[] }>(`/spaces/${enc(id)}/guests`)).guests,
  invite: (id: string, email: string, access_days: number) =>
    send<{ invite: { email: string }; accept_url: string }>("POST", `/spaces/${enc(id)}/guests`, {
      email,
      access_days,
    }),
  removeGuest: (id: string, userId: string) =>
    send<unknown>("DELETE", `/spaces/${enc(id)}/guests/${enc(userId)}`),
  setPartyLevel: (id: string, resourceRowId: string, partyId: string, level: string) =>
    send<unknown>("PATCH", `/spaces/${enc(id)}/resources/${enc(resourceRowId)}`, {
      per_party: { [partyId]: level },
    }),

  /** True when the share only waits for a Space admin (202). */
  shareAgent: async (
    id: string,
    input: { resource_id: string; access: string; per_party?: Record<string, string> },
  ) => {
    const made = await send<{ request?: unknown }>("POST", `/spaces/${enc(id)}/resources`, {
      resource_type: "agent",
      ...input,
    });
    return Boolean(made.request);
  },
  shareRequests: async (id: string) =>
    (await call<{ shares: ShareRequest[] }>(`/spaces/${enc(id)}/requests`)).shares,
  decideShare: (
    id: string,
    requestId: string,
    decision: { decision: "accept" } | { decision: "deny"; reason: string },
  ) => send<unknown>("POST", `/spaces/${enc(id)}/share-requests/${enc(requestId)}`, decision),

  phases: async (id: string) =>
    (await call<{ phases: Phase[] }>(`/spaces/${enc(id)}/phases`)).phases,
  createPhase: (id: string, name: string) =>
    send<unknown>("POST", `/spaces/${enc(id)}/phases`, { name }),
  unlockPhase: (id: string, phaseId: string) =>
    send<unknown>("POST", `/spaces/${enc(id)}/phases/${enc(phaseId)}/unlock`),
  tasks: async (id: string) => (await call<{ tasks: Task[] }>(`/spaces/${enc(id)}/tasks`)).tasks,
  createTask: async (
    id: string,
    input: { name: string; phase_id?: string | null; gate?: boolean; assignee?: Assignee },
  ) => (await send<{ task: Task }>("POST", `/spaces/${enc(id)}/tasks`, input)).task,
  setStatus: async (taskId: string, status: TaskStatus) =>
    (await send<{ task: Task }>("PATCH", `/tasks/${enc(taskId)}`, { status })).task,
  approve: (taskId: string) => send<unknown>("POST", `/tasks/${enc(taskId)}/approve`),
  reject: (taskId: string, comment: string) =>
    send<unknown>("POST", `/tasks/${enc(taskId)}/reject`, { comment }),
  comments: async (taskId: string) =>
    (await call<{ comments: Comment[] }>(`/tasks/${enc(taskId)}/comments`)).comments,
  addComment: (taskId: string, body_md: string) =>
    send<unknown>("POST", `/tasks/${enc(taskId)}/comments`, { body_md }),
  exportUrl: (id: string) => `/api/v1/spaces/${enc(id)}/tasks/export`,
};
