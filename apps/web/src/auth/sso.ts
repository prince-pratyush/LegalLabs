const WHY: Record<string, string> = {
  failed: "Single sign-on didn't work. Ask your administrator if it keeps happening.",
  unavailable: "Single sign-on isn't available for that workspace.",
  busy: "Too many attempts. Wait a minute, then try again.",
};

/** What single sign-on came back with, `#/auth/sso?error=…`. Only these words are shown. */
export function ssoErrorFrom(hash: string): string | null {
  const [path, query] = hash.split("?");
  if (path !== "#/auth/sso") return null;
  return WHY[new URLSearchParams(query).get("error") ?? ""] ?? null;
}

export const ssoStart = (workspace: string) =>
  `/auth/oidc/start?workspace=${encodeURIComponent(workspace)}`;
