import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { safeRequest } from "../auth/oidc/fetch.js";
import { rpcStream } from "./sse.js";

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

/** One HTTPS exchange with an MCP server. Injected so tests can serve a local fake. */
export type McpTransport = typeof safeRequest;

const PROTOCOL = "2025-06-18";
/** Visible ASCII only, as the MCP specification requires, and not unbounded. */
const SESSION_ID = /^[\x21-\x7e]{1,1024}$/;

interface Reply {
  result?: { protocolVersion?: unknown; tools?: unknown[]; content?: unknown; isError?: unknown };
  error?: { message?: unknown };
}

/**
 * MCP over streamable HTTP, answered with JSON or an event stream, with or without a session.
 * The default transport is `safeRequest`: it refuses private and link-local addresses on the
 * connection it actually makes, so a name that resolves (or is re-pointed) inside the network
 * gets nothing, and it follows no redirects. The server's bearer token is only ever sent to an
 * address that passed. Each exchange has a size cap and an overall deadline. What the server
 * sends besides the reply asked for (notifications, requests of its own) is ignored.
 */
export function mcpSession(
  url: string,
  auth: DiscoveryAuth,
  options: {
    transport?: McpTransport;
    signal?: AbortSignal;
    timeoutMs?: number;
    deadlineMs?: number;
  } = {},
) {
  const transport = options.transport ?? safeRequest;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(auth.kind === "bearer" ? { authorization: `Bearer ${auth.token}` } : {}),
  };
  const limits = {
    timeoutMs: options.timeoutMs ?? 15_000,
    deadlineMs: options.deadlineMs ?? 60_000,
    maxBytes: 2_000_000,
  };
  /** What the server asked us to send back after `initialize`. */
  let session: Record<string, string> = {};
  let id = 0;
  const post = async (message: object, awaiting?: number) => {
    const stream = awaiting === undefined ? null : rpcStream(awaiting);
    const res = await transport(url, limits, {
      method: "POST",
      headers: { ...headers, ...session },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(stream
        ? { enough: (chunk, h) => isEventStream(h["content-type"]) && stream.push(chunk) }
        : {}),
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`server answered ${res.status}`);
    return { res, stream };
  };
  const rpc = async (method: string, params: object) => {
    id += 1;
    const { res, stream } = await post({ id, method, params }, id);
    const reply: unknown = isEventStream(res.headers["content-type"])
      ? stream?.reply()
      : JSON.parse(res.body);
    if (!reply || typeof reply !== "object") throw new Error("no reply to the request");
    return { reply: reply as Reply, headers: res.headers };
  };
  /** A fresh session, as the lifecycle requires: initialize, then say it is done. */
  const initialize = async () => {
    session = {};
    const { reply, headers: answered } = await rpc("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "legallabs", version: "1" },
    });
    if (reply.error) throw new Error("server refused to initialise");
    const given = answered["mcp-session-id"];
    if (given !== undefined && (typeof given !== "string" || !SESSION_ID.test(given))) {
      throw new Error("unusable session id");
    }
    const version = reply.result?.protocolVersion;
    session = {
      "mcp-protocol-version":
        typeof version === "string" && /^\d{4}-\d{2}-\d{2}$/.test(version) ? version : PROTOCOL,
      ...(given ? { "mcp-session-id": given } : {}),
    };
    await post({ method: "notifications/initialized" });
  };
  return {
    /** Initialises, then reads the manifest this server presents now. */
    async listTools(): Promise<RawTool[]> {
      await initialize();
      const { reply } = await rpc("tools/list", {});
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
    },
    /** Calls one tool. The text is whatever the server sent: untrusted. */
    async callTool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ text: string; isError: boolean }> {
      const { reply } = await rpc("tools/call", { name, arguments: args });
      if (reply.error) return { text: String(reply.error.message ?? "tool error"), isError: true };
      const content = reply.result?.content;
      if (!Array.isArray(content)) throw new Error("no content in reply");
      const text = content
        .map((part) => {
          const x = part as { type?: unknown; text?: unknown };
          return x.type === "text" ? String(x.text ?? "") : "[non-text content left out]";
        })
        .join("\n");
      return { text, isError: reply.result?.isError === true };
    },
    /** Tells the server the session is over. Best effort: a server may refuse, or be gone. */
    async close(): Promise<void> {
      if (!session["mcp-session-id"]) return;
      const ending = { ...headers, ...session };
      session = {};
      try {
        await transport(
          url,
          { ...limits, timeoutMs: 2_000, deadlineMs: 2_000 },
          { method: "DELETE", headers: ending },
        );
      } catch {
        // Nothing depends on it.
      }
    },
  };
}

const isEventStream = (contentType: string | undefined) =>
  contentType?.split(";")[0]?.trim().toLowerCase() === "text/event-stream";

/** Lists a real server's tools through the guarded transport. */
export const httpDiscovery: McpDiscovery = (url, auth) => listOnce(mcpSession(url, auth));

/** One listing, then the session is ended. */
export async function listOnce(session: ReturnType<typeof mcpSession>): Promise<RawTool[]> {
  try {
    return await session.listTools();
  } finally {
    await session.close();
  }
}

/** A manifest as it is pinned: the first tool of each name counts. */
export function uniqueTools(tools: readonly RawTool[]): RawTool[] {
  const names = new Set<string>();
  return tools.filter((t) => !names.has(t.name) && names.add(t.name));
}
