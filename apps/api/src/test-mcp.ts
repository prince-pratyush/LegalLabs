import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolPolicy } from "@legallabs/contracts";
import type pg from "pg";
import { createAdminConnectors } from "./admin-models/connectors.js";
import { type McpTransport, mcpSession, type RawTool } from "./admin-models/discovery.js";
import { createSecretBox } from "./admin-models/secrets.js";
import type { Principal } from "./auth/auth.js";
import { safeRequest } from "./auth/oidc/fetch.js";

// Test support: an MCP server on loopback and the connector that points at it.

export const PUBLIC_URL = "https://mcp.vendor.io/mcp";
export const TOKEN = "tok_fake_mcp_secret_value";

export const readTool = (name: string, extra: Partial<RawTool> = {}): RawTool => ({
  name,
  description: `${name} tool`,
  input_schema: { type: "object", properties: { q: { type: "string" } } },
  annotations: { readOnlyHint: true },
  ...extra,
});

export const writeTool = (name: string): RawTool => ({
  name,
  description: `${name} tool`,
  input_schema: {
    type: "object",
    properties: { to: { type: "string" }, body: { type: "string" } },
    required: ["to"],
    additionalProperties: false,
  },
  // No annotations at all: MCP's default is that it may write.
  annotations: {},
});

export interface FakeMcp {
  /** What tools/list answers; change it to make the manifest drift. */
  tools: RawTool[];
  /** What each tool returns. */
  replies: Record<string, string>;
  /** Every tools/call the server received. */
  calls: { name: string; arguments: Record<string, unknown> }[];
  /** Every request, by method, with the authorization header it carried. */
  requests: { method: string; authorization: string }[];
  /** Holds tools/call open until the request is dropped. */
  hang: boolean;
  /** Where it really listens, on loopback. */
  url: string;
  transport: McpTransport;
  close(): Promise<void>;
}

export async function startFakeMcp(tools: RawTool[]): Promise<FakeMcp> {
  const fake: Omit<FakeMcp, "url" | "transport" | "close"> = {
    tools,
    replies: {},
    calls: [],
    requests: [],
    hang: false,
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      fake.requests.push({ method, authorization: req.headers.authorization ?? "" });
      const reply = (result: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      };
      if (method === "tools/list") {
        return reply({
          tools: fake.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.input_schema,
            annotations: t.annotations,
          })),
        });
      }
      if (method === "tools/call") {
        fake.calls.push(params);
        if (fake.hang) return;
        return reply({
          content: [{ type: "text", text: fake.replies[params.name] ?? `${params.name} done` }],
        });
      }
      return reply({});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  // The real guarded client, told that this one address is the public one.
  const transport: McpTransport = (url, policy, init) => {
    if (url !== PUBLIC_URL) throw new Error(`unexpected connector url ${url}`);
    return safeRequest(local, { ...policy, insecureDev: true }, init);
  };
  return Object.assign(fake, {
    url: local,
    transport,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}

export const testSecrets = createSecretBox(randomBytes(32).toString("base64"));

export function testConnectors(pool: pg.Pool, fake: FakeMcp) {
  return createAdminConnectors(pool, {
    secrets: testSecrets,
    discovery: (url, auth) => mcpSession(url, auth, { transport: fake.transport }).listTools(),
  });
}

/** Registers, discovers, sets each tool's policy and approves, as an admin would. */
export async function enableConnector(
  connectors: ReturnType<typeof createAdminConnectors>,
  admin: { userId: string; workspaceId: string },
  policies: Record<string, ToolPolicy>,
  name = "vendor",
): Promise<string> {
  const p: Principal = { sessionId: randomUUID(), ...admin };
  const client = { ip: null, userAgent: null };
  const made = await connectors.register(
    p,
    { name, url: PUBLIC_URL, auth: { kind: "bearer", token: TOKEN } },
    client,
  );
  if (!made.ok) throw new Error(made.reason);
  const found = await connectors.discover(p, made.value.id, client);
  if (!found.ok) throw new Error(found.reason);
  for (const [tool, policy] of Object.entries(policies)) {
    await connectors.setToolPolicy(p, made.value.id, tool, policy, client);
  }
  const approved = await connectors.approve(p, made.value.id, client);
  if (!approved.ok) throw new Error(approved.reason);
  return made.value.id;
}
