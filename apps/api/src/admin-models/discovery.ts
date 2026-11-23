import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { safeRequest } from "../auth/oidc/fetch.js";

export interface RawTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

export type DiscoveryAuth = { kind: "none" } | { kind: "bearer"; token: string };

/** Lists a server's tools. Injected so tests never touch the network. Throws on any failure. */
export type McpDiscovery = (url: string, auth: DiscoveryAuth) => Promise<RawTool[]>;

// Names that never reach the public internet. A resolver on a private network often answers for
// them, so a connector pointed at one would be a request from inside that network.
const PRIVATE_SUFFIX =
  /(^|\.)(localhost|localdomain|local|internal|intranet|lan|home|corp|private|test|invalid|example|home\.arpa|in-addr\.arpa|ip6\.arpa)$/;

/**
 * Only public HTTPS hosts: no literal IPs, localhost, or internal-looking names. This is the
 * first check, on the name alone. The connection itself is checked again on the address it
 * actually reaches (see `httpDiscovery`), because a public-looking name can resolve to a
 * private address.
 */
export function safeConnectorUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    // "localhost." is the same host as "localhost": the trailing dot is the DNS root.
    const host = u.hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase()
      .replace(/\.+$/, "");
    if (host === "" || isIP(host) !== 0) return false;
    return host.includes(".") && !PRIVATE_SUFFIX.test(host);
  } catch {
    return false;
  }
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Stable JSON: keys sorted, so the same tool always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The pinned identity of one tool: name, description, input schema and annotations (CON-001 tool
 * pinning, 06-security 7.3). The annotations are what the policy engine reads to tell a read
 * from a write, so a server that flips `readOnlyHint` after approval must show up as drift.
 */
export const toolHash = (t: RawTool) =>
  sha(
    canonical({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      annotations: t.annotations,
    }),
  );

export const manifestHash = (hashes: readonly string[]) => sha([...hashes].sort().join("\n"));

/** MCP over streamable HTTP: initialise, then tools/list. JSON replies only. */
export const httpDiscovery: McpDiscovery = async (url, auth) => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...(auth.kind === "bearer" ? { authorization: `Bearer ${auth.token}` } : {}),
  };
  // safeRequest refuses private and link-local addresses on the connection it actually makes, so
  // a name that resolves (or is re-pointed) inside the network gets nothing, and it follows no
  // redirects. The server's bearer token is only ever sent to an address that passed.
  const call = async (id: number, method: string, params: object) => {
    const res = await safeRequest(
      url,
      { timeoutMs: 15_000, maxBytes: 2_000_000 },
      {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      },
    );
    if (res.status < 200 || res.status >= 300) throw new Error(`server answered ${res.status}`);
    return JSON.parse(res.body) as { result?: { tools?: unknown[] } };
  };
  await call(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "legallabs", version: "1" },
  });
  const reply = await call(2, "tools/list", {});
  const tools = reply.result?.tools;
  if (!Array.isArray(tools)) throw new Error("no tool list in reply");
  return tools
    .slice(0, 200)
    .map((t) => {
      const x = t as Record<string, unknown>;
      return {
        name: String(x.name ?? "").slice(0, 200),
        description: String(x.description ?? ""),
        input_schema: (x.inputSchema as Record<string, unknown>) ?? {},
        annotations: (x.annotations as Record<string, unknown>) ?? {},
      };
    })
    .filter((t) => t.name.length > 0);
};
