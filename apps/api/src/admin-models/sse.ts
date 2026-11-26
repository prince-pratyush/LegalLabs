import { StringDecoder } from "node:string_decoder";

/**
 * Reads a server-sent event stream a chunk at a time, looking for the JSON-RPC reply to one
 * request (MCP streamable HTTP). Everything else on the stream is dropped: notifications,
 * requests from the server, comments and anything that isn't JSON. Size is capped by the
 * transport, which counts the bytes as they arrive.
 */
export function rpcStream(id: number) {
  const decoder = new StringDecoder("utf8");
  let line: string[] = [];
  let data: string[] = [];
  let event = "";
  let afterCr = false;
  let found: object | undefined;

  const dispatch = () => {
    const text = data.join("\n");
    const type = event;
    data = [];
    event = "";
    if (!text || (type !== "" && type !== "message")) return;
    try {
      const message = JSON.parse(text);
      if (message?.id === id && ("result" in message || "error" in message)) found = message;
    } catch {
      // Not a message.
    }
  };
  const field = (text: string) => {
    if (text === "") return dispatch();
    const colon = text.indexOf(":");
    const name = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? "" : text.slice(colon + 1).replace(/^ /, "");
    if (name === "data") data.push(value);
    else if (name === "event") event = value;
  };

  return {
    /** True once the reply has been read. */
    push(chunk: Buffer): boolean {
      let text = decoder.write(chunk);
      if (!text) return found !== undefined;
      // Lines end in CR, LF or CRLF, and a CRLF can be split between chunks.
      if (afterCr && text.startsWith("\n")) text = text.slice(1);
      afterCr = text.endsWith("\r");
      const parts = text.split(/\r\n|\r|\n/);
      const rest = parts.pop() ?? "";
      for (const part of parts) {
        if (found) break;
        line.push(part);
        field(line.join(""));
        line = [];
      }
      line.push(rest);
      return found !== undefined;
    },
    reply: () => found,
  };
}
