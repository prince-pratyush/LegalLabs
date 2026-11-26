import { ApiError, FALLBACK } from "../api.js";

/** A sign-in that has passed the password (or the identity provider) and still owes a factor. */
export interface Pending {
  token: string;
  /** A factor is required and none is set up yet. */
  enrol: boolean;
  methods: string[];
}

interface Challenge {
  challenge_id: string;
  options: unknown;
}
interface Enrolled {
  recovery_codes?: string[] | null;
}

/** These run before there is a session, under /auth rather than /api/v1. */
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/auth${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new ApiError(res.status, String(parsed?.error ?? parsed?.code ?? "UNKNOWN"), FALLBACK);
  }
  return parsed as T;
}

export const secondFactorApi = {
  /** Resolves to the second step still owed, or null once the session cookie is set. */
  async login(workspace: string, email: string, password: string): Promise<Pending | null> {
    const reply = await post<{
      mfa_token?: string;
      mfa_enrolment_required?: boolean;
      methods?: string[];
    }>("/login", { workspace, email, password });
    return reply.mfa_token
      ? {
          token: reply.mfa_token,
          enrol: reply.mfa_enrolment_required === true,
          methods: reply.methods ?? [],
        }
      : null;
  },
  totp: (mfa_token: string, code: string) => post<unknown>("/mfa/totp", { mfa_token, code }),
  recovery: (mfa_token: string, code: string) =>
    post<unknown>("/mfa/recovery", { mfa_token, code }),
  passkeyOptions: (mfa_token: string) => post<Challenge>("/mfa/passkey/options", { mfa_token }),
  passkeyVerify: (mfa_token: string, challenge_id: string, response: unknown) =>
    post<unknown>("/mfa/passkey/verify", { mfa_token, challenge_id, response }),
  totpBegin: (mfa_token: string) =>
    post<{ secret: string; uri: string }>("/mfa/enrol/totp/begin", { mfa_token }),
  totpConfirm: (mfa_token: string, code: string) =>
    post<Enrolled>("/mfa/enrol/totp/confirm", { mfa_token, code }),
  registerOptions: (mfa_token: string) =>
    post<Challenge>("/mfa/enrol/passkey/options", { mfa_token }),
  registerVerify: (mfa_token: string, challenge_id: string, response: unknown) =>
    post<Enrolled>("/mfa/enrol/passkey/verify", { mfa_token, challenge_id, response }),
};

/** Single sign-on comes back to #/auth/mfa?kind=…&token=…&methods=… when a factor is owed. */
export function handoffFrom(hash: string): Pending | null {
  const [path, query] = hash.split("?");
  if (path !== "#/auth/mfa") return null;
  const params = new URLSearchParams(query);
  const token = params.get("token");
  return token
    ? {
        token,
        enrol: params.get("kind") === "enrol",
        methods: (params.get("methods") ?? "").split(",").filter(Boolean),
      }
    : null;
}
