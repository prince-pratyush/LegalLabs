import type {
  ImportApplied,
  ImportMode,
  ImportPreview,
  Matter,
  MatterCreate,
  MatterOptions,
  MatterPatch,
  WallCreate,
  WallCsvPreview,
  WallEvaluation,
  WallProviderKind,
  WallRow,
  WallSyncReport,
} from "@legallabs/contracts";
import { ApiError } from "../api.js";

export type { Matter, MatterOptions, WallRow };

export interface WallProvider {
  kind: WallProviderKind;
  cadence_minutes: number | null;
  last_sync_at: string | null;
  last_status: string | null;
  supported: WallProviderKind[];
}

export interface Principal {
  principal_type: "user" | "group";
  principal_id: string;
  label: string;
}

/** A refused request; `body` keeps extra fields such as a rejected walls preview. */
export class MatterApiError extends ApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly body: Record<string, unknown> | null,
  ) {
    super(status, code, message);
  }
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
    throw new MatterApiError(
      res.status,
      String(body?.code ?? "UNKNOWN"),
      typeof body?.message === "string" ? body.message : FALLBACK,
      body,
    );
  }
  return body as T;
}

const send = <T>(method: string, path: string, body?: unknown) =>
  call<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const m = (id: string) => `/matters/${encodeURIComponent(id)}`;
const upload = <T>(path: string, file: File, extra: Record<string, string> = {}) => {
  const form = new FormData();
  form.set("file", file);
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return call<T>(path, { method: "POST", body: form });
};

export const matterApi = {
  list: async (query: { q?: string; picker?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.picker) params.set("scope", "picker");
    const qs = params.toString();
    return (await call<{ items: Matter[] }>(`/matters${qs ? `?${qs}` : ""}`)).items;
  },
  create: async (input: MatterCreate) =>
    (await send<{ matter: Matter }>("POST", "/matters", input)).matter,
  update: async (id: string, patch: MatterPatch) =>
    (await send<{ matter: Matter }>("PATCH", m(id), patch)).matter,
  close: async (id: string) => (await send<{ matter: Matter }>("POST", `${m(id)}/close`)).matter,
  acknowledge: (id: string) =>
    send<{ acknowledged_at: string; notice_version: number }>("POST", `${m(id)}/acknowledge`),
  options: () => call<MatterOptions>("/admin/matters/options"),
  setOptions: (options: MatterOptions) =>
    send<MatterOptions>("PUT", "/admin/matters/options", options),
  importPreview: (file: File, mode: ImportMode) =>
    upload<ImportPreview>("/matters/import", file, { mode }),
  importReportUrl: (token: string) =>
    `/api/v1/matters/import/${encodeURIComponent(token)}/report`,
  importApply: (token: string) =>
    send<ImportApplied>("POST", `/matters/import/${encodeURIComponent(token)}/apply`),

  walls: async (matterId?: string) =>
    (
      await call<{ items: WallRow[] }>(
        `/admin/walls${matterId ? `?filter[matter_id]=${encodeURIComponent(matterId)}` : ""}`,
      )
    ).items,
  addWall: async (input: WallCreate) =>
    (await send<{ wall: WallRow }>("POST", "/admin/walls", input)).wall,
  removeWall: (id: string) => send<null>("DELETE", `/admin/walls/${encodeURIComponent(id)}`),
  principals: async (q: string) =>
    (await call<{ items: Principal[] }>(`/admin/walls/principals?q=${encodeURIComponent(q)}`))
      .items,
  wallPreview: (file: File) => upload<WallCsvPreview>("/admin/walls/import", file),
  wallApply: (token: string) =>
    send<{ matters: number; add: number; remove: number }>(
      "POST",
      `/admin/walls/import/${encodeURIComponent(token)}/apply`,
    ),
  provider: () => call<WallProvider>("/admin/walls/provider"),
  setProvider: (kind: WallProviderKind) =>
    send<WallProvider>("PUT", "/admin/walls/provider", { kind }),
  syncs: async () => (await call<{ items: WallSyncReport[] }>("/admin/walls/provider/syncs")).items,
  evaluate: (userId: string, matterId: string) =>
    send<WallEvaluation>("POST", "/admin/walls/evaluate", {
      user_id: userId,
      matter_id: matterId,
    }),
};

export const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : FALLBACK);
