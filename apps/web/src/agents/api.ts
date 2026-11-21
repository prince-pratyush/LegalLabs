import type {
  AccessLevel,
  AgentAttachment,
  AgentSource,
  ApprovalConfig,
  DiffOp,
  ImportIssue,
  RunSignal,
  RunStep,
  RunSummary,
  Schedule,
  SharePrincipalType,
} from "@legallabs/contracts";
import { ApiError, FALLBACK } from "../api.js";

export interface ScheduleView extends Schedule {
  status: "active" | "paused";
  paused_reason: string | null;
  next_run_at: string | null;
}

export interface Agent {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  practice_areas: string[];
  status: "draft" | "live";
  live_version_id: string | null;
  draft_version_id: string | null;
  auto_description: boolean;
  my_access: AccessLevel;
  created_at: string;
  updated_at: string;
  stats: { runs: number; test_runs: number; last_run_at: string | null };
  schedule: ScheduleView | null;
}

export interface AgentVersion {
  id: string;
  agent_id: string;
  no: number;
  instructions: string;
  attachments: AgentAttachment[];
  sources: AgentSource[];
  created_by: string;
  created_at: string;
}

export interface VersionDiff {
  instructions_diff: DiffOp[];
  attachments: { added: AgentAttachment[]; removed: AgentAttachment[] };
  sources: { added: AgentSource[]; removed: AgentSource[] };
}

export type ImportFileStatus = ImportIssue["status"];

export interface ImportPreviewResponse {
  token: string;
  title: string;
  description: string;
  instructions: string;
  files: { label: string; name: string; size: number; status: ImportFileStatus }[];
  refs: { label: string; kind: string; name: string; resolved: boolean }[];
  sources: { label: string; source: string; status: ImportFileStatus }[];
  issues: ImportIssue[];
}

export interface Grant {
  id: string;
  principal_type: SharePrincipalType;
  principal_id: string;
  level: AccessLevel;
  granted_by: string;
  granted_at: string;
}

export interface ShareRequest {
  id: string;
  principal_type: SharePrincipalType;
  principal_id: string;
  level: AccessLevel;
  approver: string;
  status: "pending" | "accepted" | "denied";
  requested_by: string;
  reason: string | null;
  created_at: string;
}

export interface QueuedRequest extends ShareRequest {
  resource_type: string;
  resource_id: string;
  title: string | null;
}

export interface Started {
  run_id: string;
  thread_id: string;
}

export interface Principal {
  principal_type: "user" | "group";
  principal_id: string;
  label: string;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "same-origin",
    headers: typeof init.body === "string" ? { "content-type": "application/json" } : {},
  });
  if (res.status === 204 || res.status === 202) {
    const text = await res.text().catch(() => "");
    return (text ? JSON.parse(text) : undefined) as T;
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
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
const a = (id: string) => `/agents/${enc(id)}`;

export interface AgentFilter {
  owner?: "me" | "shared";
  scheduled?: boolean;
  practiceArea?: string;
  q?: string;
}

export const agentApi = {
  list: async (filter: AgentFilter = {}) => {
    const params = new URLSearchParams();
    if (filter.owner) params.set("filter[owner]", filter.owner);
    if (filter.scheduled) params.set("filter[scheduled]", "true");
    if (filter.practiceArea) params.set("filter[practice_area]", filter.practiceArea);
    if (filter.q?.trim()) params.set("q", filter.q.trim());
    const query = params.toString();
    return (await call<{ agents: Agent[] }>(`/agents${query ? `?${query}` : ""}`)).agents;
  },
  create: async (mode: "describe" | "scratch", title?: string) =>
    (await send<{ agent: Agent }>("POST", "/agents", { mode, ...(title ? { title } : {}) })).agent,
  get: async (id: string) => (await call<{ agent: Agent }>(a(id))).agent,
  patch: async (
    id: string,
    patch: Partial<Pick<Agent, "title" | "description" | "practice_areas" | "auto_description">>,
  ) => (await send<{ agent: Agent }>("PATCH", a(id), patch)).agent,
  remove: (id: string) => send<void>("DELETE", a(id)),
  duplicate: async (id: string) =>
    (await send<{ agent: Agent }>("POST", `${a(id)}/duplicate`)).agent,

  versions: async (id: string) =>
    (await call<{ versions: AgentVersion[] }>(`${a(id)}/versions`)).versions,
  saveVersion: (
    id: string,
    input: {
      instructions: string;
      attachments: AgentAttachment[];
      sources: AgentSource[];
      promote: boolean;
    },
  ) =>
    send<{ version: AgentVersion; warnings: { code: string; label: string }[] }>(
      "POST",
      `${a(id)}/versions`,
      input,
    ),
  diff: (id: string, from: string, to: string) =>
    call<VersionDiff>(`${a(id)}/versions/${enc(from)}/diff/${enc(to)}`),
  discardDraft: (id: string) => send<void>("DELETE", `${a(id)}/draft`),

  importFile: async (file: File) => {
    const form = new FormData();
    form.set("file", file);
    return call<ImportPreviewResponse>("/agents/import", { method: "POST", body: form });
  },
  confirmImport: async (token: string, input: { title?: string; drop_labels: string[] }) =>
    (await send<{ agent: Agent }>("POST", `/agents/import/${enc(token)}/confirm`, input)).agent,
  exportUrl: (id: string) => `/api/v1${a(id)}/export`,

  setSchedule: async (id: string, schedule: Schedule) =>
    (await send<{ schedule: ScheduleView }>("PUT", `${a(id)}/schedule`, schedule)).schedule,
  removeSchedule: (id: string) => send<void>("DELETE", `${a(id)}/schedule`),
  activity: (id: string) =>
    call<{ runs: RunSummary[]; next_run_at: string | null }>(`${a(id)}/activity`),

  run: (id: string, body: { inputs?: string; thread_id?: string; matter_id?: string }) =>
    send<Started>("POST", `${a(id)}/run`, body),
  test: (id: string, body: { inputs?: string; thread_id?: string; version_id?: string }) =>
    send<Started>("POST", `${a(id)}/test`, body),
  builder: (id: string, body: { message: string; thread_id?: string }) =>
    send<Started>("POST", `${a(id)}/builder`, body),
  requestChanges: (id: string, body: { request: string; thread_id?: string }) =>
    send<{ run_id: string }>("POST", `${a(id)}/test/request-changes`, body),

  shares: (id: string) => call<{ grants: Grant[]; requests: ShareRequest[] }>(`${a(id)}/shares`),
  share: (
    id: string,
    body: { principal_type: SharePrincipalType; principal_id?: string; level: AccessLevel },
  ) => send<{ outcome: "granted" | "pending"; id: string }>("POST", `${a(id)}/shares`, body),
  unshare: (id: string, grantId: string) => send<void>("DELETE", `${a(id)}/shares/${enc(grantId)}`),
  principals: async (q: string) =>
    (await call<{ principals: Principal[] }>(`/library/principals?q=${enc(q)}`)).principals,

  nudge: async (prompt: string) =>
    (
      await send<{ nudge: { agent_id: string; title: string } | null }>("POST", "/agents/nudge", {
        prompt,
      })
    ).nudge,
  dismissNudge: (id: string) => send<void>("POST", `${a(id)}/nudge/dismiss`),

  requests: async (status: "pending" | "accepted" | "denied" = "pending") =>
    (await call<{ requests: QueuedRequest[] }>(`/admin/sharing/requests?filter[status]=${status}`))
      .requests,
  accept: (id: string) => send<void>("POST", `/admin/sharing/requests/${enc(id)}/accept`, {}),
  deny: (id: string, reason: string) =>
    send<void>("POST", `/admin/sharing/requests/${enc(id)}/deny`, reason ? { reason } : {}),
  sharingConfig: async () =>
    (await call<{ require_approval: ApprovalConfig }>("/admin/config/sharing")).require_approval,
  setSharingConfig: async (value: ApprovalConfig) =>
    (
      await send<{ require_approval: ApprovalConfig }>("PUT", "/admin/config/sharing", {
        require_approval: value,
      })
    ).require_approval,

  runs: async (filter: {
    kind: "agent" | "agent_builder";
    subjectId: string;
    testMode?: boolean;
    limit?: number;
  }) => {
    const params = new URLSearchParams({
      "filter[kind]": filter.kind,
      "filter[subject_id]": filter.subjectId,
    });
    if (filter.testMode !== undefined) params.set("test_mode", String(filter.testMode));
    if (filter.limit) params.set("limit", String(filter.limit));
    return (await call<{ runs: RunSummary[] }>(`/runs?${params}`)).runs;
  },
  signal: (runId: string, signal: RunSignal) =>
    send<void>("POST", `/runs/${enc(runId)}/signal`, signal),
  steps: async (runId: string) =>
    (await call<{ steps: RunStep[] }>(`/runs/${enc(runId)}/steps`)).steps,
};

/** The words to show for an API refusal; some codes get plainer words than the server's. */
export function agentError(err: unknown): string {
  if (!(err instanceof ApiError)) return FALLBACK;
  switch (err.code) {
    case "WALL_DENIED":
      // Never say which attachment or what walls it off.
      return "1 attachment unavailable to you. Remove it, or ask whoever added it.";
    case "AGENT_EMPTY_INSTRUCTIONS":
      return "Add instructions before saving.";
    case "AGENT_ATTACHMENT_LIMIT":
      return "An agent can hold up to 50 attachments. Remove some, then save again.";
    case "AGENT_SOURCE_LIMIT":
      return "An agent can use up to 5 sources. Remove some, then save again.";
    case "AGENT_LABEL_DUPLICATE":
      return "Each attachment and source needs its own label.";
    case "SHARE_REQUEST_COOLDOWN":
      return "That share was denied in the last 7 days, so it can't be asked for again yet.";
    case "SKILL_NO_INSTRUCTIONS":
      return "No instructions were found. Include a SKILL.md, or upload a single .md file.";
    case "SKILL_MANIFEST_INVALID":
      return "The manifest.json in that file isn't in the expected format.";
    case "SKILL_UNSAFE_ARCHIVE":
      return "That archive holds nested archives or paths outside the bundle, so it wasn't opened.";
    case "SKILL_TOO_LARGE":
    case "TOO_LARGE":
      return "That file is too large: up to 1 MB for a .md file, 50 MB and 50 files for a bundle.";
    case "SKILL_UNREADABLE":
      return "That file couldn't be read. Upload a .md, .skill or .zip file.";
    case "AGENT_INSTRUCTIONS_TOO_LONG":
      return "The instructions are longer than 20,000 characters.";
    case "RUN_FINISHED":
      return "That run has already finished.";
    default:
      return err.message;
  }
}
