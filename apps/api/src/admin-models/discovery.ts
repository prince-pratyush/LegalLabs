import { createHash } from "node:crypto";
import { isIP } from "node:net";

export interface RawTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

export type DiscoveryAuth = { kind: "none" } | { kind: "bearer"; token: string };

/** Lists a server's tools. Injected so tests never touch the network. Throws on any failure. */
export type McpDiscovery = (url: string, auth: DiscoveryAuth) => Promise<RawTool[]>;

/** Only public HTTPS hosts: no literal IPs, localhost, or internal-looking names. */
export function safeConnectorUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (isIP(host) !== 0) return false;
    return host.includes(".") && !/(^|\.)(localhost|local|internal|test)$/.test(host);
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
  const call = async (id: number, method: string, params: object) => {
    const res = await fetch(url, {
      method: "POST",
      headers,
      redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`server answered ${res.status}`);
    return (await res.json()) as { result?: { tools?: unknown[] } };
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
