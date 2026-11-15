import type {
  Playbook,
  PlaybookCreate,
  PlaybookGrant,
  PlaybookPatch,
  PlaybookSummary,
  PlaybookVersion,
} from "@legallabs/contracts";
import { ApiError } from "../api.js";

const FALLBACK = "Something went wrong. Try again.";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "same-origin",
    headers: typeof init.body === "string" ? { "content-type": "application/json" } : {},
  });
  if (res.status === 204) return undefined as T;
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
const p = (id: string) => `/playbooks/${encodeURIComponent(id)}`;

export interface ListFilter {
  status?: "published" | "unpublished";
  q?: string;
}

export const playbookApi = {
  list: async (filter: ListFilter = {}) => {
    const params = new URLSearchParams();
    if (filter.status) params.set("filter[status]", filter.status);
    if (filter.q) params.set("q", filter.q);
    return (await call<{ items: PlaybookSummary[] }>(`/playbooks?${params}`)).items;
  },
  get: async (id: string) => (await call<{ playbook: Playbook }>(p(id))).playbook,
  create: async (input: PlaybookCreate) =>
    (await send<{ playbook: Playbook }>("POST", "/playbooks", input)).playbook,
  update: async (id: string, patch: PlaybookPatch) =>
    (await send<{ playbook: Playbook }>("PATCH", p(id), patch)).playbook,
  publish: async (id: string) =>
    (await send<{ playbook: Playbook }>("POST", `${p(id)}/publish`)).playbook,
  unpublish: async (id: string) =>
    (await send<{ playbook: Playbook }>("POST", `${p(id)}/unpublish`)).playbook,
  remove: (id: string) => call<void>(p(id), { method: "DELETE" }),
  versions: async (id: string) =>
    (await call<{ items: PlaybookVersion[] }>(`${p(id)}/versions`)).items,
  version: async (id: string, no: number) =>
    (await call<{ playbook: Playbook }>(`${p(id)}/versions/${no}`)).playbook,
  grants: async (id: string) => (await call<{ grants: PlaybookGrant[] }>(`${p(id)}/grants`)).grants,
};
