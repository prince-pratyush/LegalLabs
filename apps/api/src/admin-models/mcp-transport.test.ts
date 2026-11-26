import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { safeRequest } from "../net/fetch.js";
import { PUBLIC_URL, readTool, startFakeMcp } from "../test-mcp.js";
import { listOnce, type McpTransport, mcpSession } from "./discovery.js";
import { rpcStream } from "./sse.js";

const open: { close(): unknown }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function fake() {
  const server = await startFakeMcp([readTool("search")]);
  open.push(server);
  return server;
}

/** A server that answers however a test says, reached through the real client. */
async function raw(handler: RequestListener): Promise<McpTransport> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push({
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  });
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return (_url, policy, init) => safeRequest(local, { ...policy, insecureDev: true }, init);
}

const connect = (transport: McpTransport, deadlineMs?: number) =>
  mcpSession(PUBLIC_URL, { kind: "none" }, { transport, ...(deadlineMs ? { deadlineMs } : {}) });

describe("the MCP client over streamable HTTP", () => {
  it("keeps a session, reads streams the server leaves open, and ends the session", async () => {
    const server = await fake();
    server.sse = true;
    server.sessionId = "session-1";
    const session = connect(server.transport);
    expect((await session.listTools()).map((t) => t.name)).toEqual(["search"]);
    expect((await session.callTool("search", { q: "x" })).text).toBe("search done");
    await session.close();
    expect(server.requests.map((r) => r.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(server.ended).toEqual(["session-1"]);
  });

  it("sends no DELETE when there is no session", async () => {
    const server = await fake();
    await listOnce(connect(server.transport));
    expect(server.ended).toEqual([]);
  });

  it("gives up on a server that drips bytes", async () => {
    const transport = await raw((_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      const drip = setInterval(() => res.write(": still here\n"), 20);
      res.on("close", () => clearInterval(drip));
    });
    await expect(connect(transport, 200).listTools()).rejects.toThrow("took too long");
  });

  it("caps the size of a stream", async () => {
    const transport = await raw((_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.end(`data: ${"x".repeat(2_100_000)}\n\n`);
    });
    await expect(connect(transport).listTools()).rejects.toThrow("too large");
  });

  it("fails on a stream that ends without the reply", async () => {
    const transport = await raw((_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.end('data: {"jsonrpc":"2.0","id":99,"result":{}}\n\n');
    });
    await expect(connect(transport).listTools()).rejects.toThrow("no reply");
  });

  it("refuses a session id that isn't visible ASCII", async () => {
    const server = await fake();
    server.sessionId = "has a space";
    await expect(connect(server.transport).listTools()).rejects.toThrow("unusable session id");
  });
});

describe("reading an event stream", () => {
  it("joins data lines and survives any split, any line ending and noise", () => {
    const stream = Buffer.from(
      ': hello\r\nevent: ping\r\ndata: {"id":1,"result":"no"}\r\n\r\ndata: not json\r\r' +
        'data: {"id":1,"method":"sampling/createMessage"}\n\n' +
        'id: 7\r\ndata: {"id":1,\r\ndata:"result":"é"}\r\n\r\n',
    );
    for (let size = 1; size <= 7; size += 1) {
      const reader = rpcStream(1);
      for (let at = 0; at < stream.length; at += size) reader.push(stream.subarray(at, at + size));
      expect(reader.reply()).toEqual({ id: 1, result: "é" });
    }
  });
});
