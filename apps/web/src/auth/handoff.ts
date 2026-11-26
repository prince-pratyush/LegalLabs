import type { Pending } from "@legallabs/ui";

/** Single sign-on comes back to #/auth/mfa?kind=…&methods=… when a factor is owed. */
export function handoffFrom(hash: string): Pending | null {
  const [path, query] = hash.split("?");
  if (path !== "#/auth/mfa") return null;
  const params = new URLSearchParams(query);
  const kind = params.get("kind");
  return kind === "enrol" || kind === "challenge"
    ? { enrol: kind === "enrol", methods: (params.get("methods") ?? "").split(",").filter(Boolean) }
    : null;
}
