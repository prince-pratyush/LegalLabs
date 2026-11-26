import { request, send } from "../http.js";

export type Scope = "workspace" | "vault" | "matter";
export type HoldType = "thread" | "document" | "vault" | "review_table" | "matter";

export interface PolicyRow {
  scope: Scope;
  scopeId: string;
  name: string | null;
  /** Null is kept for ever. */
  hours: number | null;
  basis: "upload" | "access";
  source: "policy" | "legacy";
  effectiveHours?: number | null;
}

export interface Policies {
  workspace: PolicyRow | null;
  vaults: PolicyRow[];
  matters: PolicyRow[];
  exemptions: { type: string; label: string }[];
}

export interface Estimate {
  threads: number;
  documents: number;
  reviewTables: number;
  total: number;
  held: number;
  firstDeletionAt: string | null;
}

export interface Hold {
  id: string;
  objectType: HoldType;
  objectId: string;
  reason: string;
  setAt: string;
}

export interface BinItem {
  id: string;
  objectType: "thread" | "document" | "review_table";
  objectId: string;
  label: string;
  deletedAt: string;
  restorableUntil: string;
  restoredAt: string | null;
  purgedAt: string | null;
}

const BASE = "/admin/retention";

const scopeQuery = (scope: Scope, scopeId: string | null) =>
  new URLSearchParams({ scope, ...(scopeId ? { scope_id: scopeId } : {}) }).toString();

export const retentionApi = {
  policies: () => request<Policies>(BASE),
  estimate: (scope: Scope, scopeId: string | null, hours: number | null) =>
    request<Estimate>(
      `${BASE}/estimate?${scopeQuery(scope, scopeId)}&hours=${hours ?? "unlimited"}`,
    ),
  setPolicy: (input: {
    scope: Scope;
    scope_id?: string;
    hours: number | null;
    basis?: "upload" | "access";
    confirm_slug?: string;
  }) => send<unknown>("PUT", `${BASE}/policy`, input),
  clearPolicy: (scope: Scope, scopeId: string | null) =>
    send<void>("DELETE", `${BASE}/policy?${scopeQuery(scope, scopeId)}`),
  holds: async () => (await request<{ holds: Hold[] }>(`${BASE}/holds`)).holds,
  setHold: (input: { object_type: HoldType; object_id: string; held: boolean; reason?: string }) =>
    send<unknown>("PUT", `${BASE}/holds`, input),
  bin: async (includeClosed: boolean) =>
    (
      await request<{ items: BinItem[] }>(
        `${BASE}/bin${includeClosed ? "?include_closed=true" : ""}`,
      )
    ).items,
  restore: (id: string) => send<unknown>("POST", `${BASE}/bin/${encodeURIComponent(id)}/restore`),
};

/** The second factor, asked for again before a sensitive change (SEC-007). */
export const stepUpApi = {
  factors: () => request<{ totp: boolean; passkeys: unknown[] }>("/mfa"),
  totp: (code: string) => send<unknown>("POST", "/mfa/step-up/totp", { code }),
  recovery: (code: string) => send<unknown>("POST", "/mfa/step-up/recovery", { code }),
  passkeyOptions: () =>
    send<{ challenge_id: string; options: PublicKeyCredentialRequestOptionsJSON }>(
      "POST",
      "/mfa/step-up/passkey/options",
    ),
  passkeyVerify: (challengeId: string, response: unknown) =>
    send<unknown>("POST", "/mfa/step-up/passkey/verify", {
      challenge_id: challengeId,
      response,
    }),
};
