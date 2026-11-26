import { ApiError, FALLBACK } from "../api.js";
import { request, send } from "../http.js";

export interface InvitePreview {
  email: string;
  space_name: string;
  workspace_name: string;
  party_name: string;
  expires_at: string;
}

export interface GuestSpaceSummary {
  space_id: string;
  space_name: string;
  party_id: string;
  party_name: string;
  connection_status: string;
  can_approve: boolean;
  expires_at: string;
}

export interface GuestSpaceView {
  space: { id: string; name: string; workspace_name: string | null };
  party: { id: string; name: string };
  resources: { id: string; resource_type: string; name: string | null; access: string }[];
}

/** The routes used before anyone is signed in live under /guest, outside /api/v1. */
async function open<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/guest${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(parsed?.code ?? "UNKNOWN"),
      typeof parsed?.message === "string" ? parsed.message : FALLBACK,
    );
  }
  return parsed as T;
}

const enc = encodeURIComponent;

export const guestApi = {
  preview: (token: string) => open<InvitePreview>("/invites/preview", { token }),
  accept: (token: string, name: string) =>
    open<{ workspace: string; space_id: string }>("/invites/accept", { token, name }),
  requestCode: (workspace: string, email: string) =>
    open<null>("/login/code", { workspace, email }),
  verify: (workspace: string, email: string, code: string) =>
    open<unknown>("/login/verify", { workspace, email, code }),

  spaces: async () => (await request<{ spaces: GuestSpaceSummary[] }>("/guest/spaces")).spaces,
  space: (id: string) => request<GuestSpaceView>(`/guest/spaces/${enc(id)}`),
  approve: (id: string) =>
    send<{ status: string }>("POST", `/guest/spaces/${enc(id)}/connection/approve`),
  reject: (id: string) => send<null>("POST", `/guest/spaces/${enc(id)}/connection/reject`, {}),
};
