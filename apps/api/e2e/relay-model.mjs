// A relay stand-in for an OpenAI-compatible model server: every model request is written
// to a folder and the server waits for a reply file, so a person (or a Claude session
// acting as the model) can answer each prompt. It makes the same calls a real provider
// gets, so it shows what a strong model does with our prompts and parsers with no paid
// API. Not a benchmark: no real latency, tokens or model identity. See relay-model.md.
//
//   node e2e/relay-model.mjs --dir /tmp/relay [--port 0] [--model-name relay]
//   PILOT_OLLAMA_URL=<printed url> node e2e/stack.mjs      # the API uses it as its model
//
// Folder layout (NNNNN is a zero-padded sequence number):
//   pending/NNNNN.request.txt    what was asked: a header, then the SYSTEM and USER turns
//   pending/NNNNN.request.json   the same request as the API sent it
//   responses/NNNNN.response.txt write the reply text here to answer (write it last, whole)
//   responses/NNNNN.error.txt    write an HTTP status (e.g. 500) here to fail the call instead
//   done/                        answered requests move here, with their reply
//   cancelled/                   requests the caller gave up on (client timeout or abort)
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const text = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.text ?? "").join("")
      : String(content ?? "");

export function renderRequest(seq, body) {
  const turns = (body.messages ?? []).map(
    (m) => `===== ${String(m.role).toUpperCase()} =====\n${text(m.content)}`,
  );
  const params = {
    model: body.model,
    stream: Boolean(body.stream),
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? null,
    temperature: body.temperature ?? null,
    response_format: body.response_format ?? null,
    tools: body.tools ? body.tools.length : 0,
  };
  return `REQUEST ${seq}  ${JSON.stringify(params)}\nReply by writing the assistant message text to responses/${seq}.response.txt\n\n${turns.join("\n\n")}\n`;
}

/** Starts the relay on 127.0.0.1. `dir` holds the request and reply files. */
export function startRelayModel({ dir, port = 0, modelName = "relay", waitMs = 3_600_000 } = {}) {
  for (const sub of ["pending", "responses", "done", "cancelled"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  let next = 1;
  const ref = (seq) => String(seq).padStart(5, "0");
  // Moves an answered request, with its reply, out of pending/ so a worker never sees it twice.
  const finish = (seq) => {
    for (const ext of ["request.txt", "request.json"]) {
      try {
        renameSync(join(dir, "pending", `${seq}.${ext}`), join(dir, "done", `${seq}.${ext}`));
      } catch {}
    }
    for (const ext of ["response.txt", "error.txt"]) {
      try {
        renameSync(join(dir, "responses", `${seq}.${ext}`), join(dir, "done", `${seq}.${ext}`));
      } catch {}
    }
  };
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: modelName, object: "model" }] }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      res.writeHead(400).end("bad json");
      return;
    }
    const seq = ref(next++);
    const base = join(dir, "pending", seq);
    writeFileSync(`${base}.request.json`, JSON.stringify(body, null, 2));
    writeFileSync(`${base}.request.txt`, renderRequest(seq, body));
    const replyFile = join(dir, "responses", `${seq}.response.txt`);
    const errorFile = join(dir, "responses", `${seq}.error.txt`);
    let gone = false;
    res.on("close", () => {
      if (!res.writableEnded) gone = true;
    });
    const stream = Boolean(body.stream);
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    }
    const until = Date.now() + waitMs;
    for (;;) {
      if (gone || Date.now() > until) {
        for (const ext of ["request.txt", "request.json"]) {
          try {
            renameSync(`${base}.${ext}`, join(dir, "cancelled", `${seq}.${ext}`));
          } catch {}
        }
        if (!gone) res.writeHead(504).end("relay timed out");
        return;
      }
      if (existsSync(errorFile)) {
        const status = Number(readFileSync(errorFile, "utf8").trim()) || 500;
        finish(seq);
        if (stream) {
          res.end(
            `data: ${JSON.stringify({ error: { message: "relay error", code: status } })}\n\n`,
          );
        } else {
          res.writeHead(status, { "content-type": "text/plain" }).end("relay error");
        }
        return;
      }
      if (existsSync(replyFile)) break;
      if (stream) res.write(": waiting\n\n");
      await new Promise((r) => setTimeout(r, 500));
    }
    const reply = readFileSync(replyFile, "utf8");
    finish(seq);
    const usage = {
      prompt_tokens: Math.ceil(raw.length / 4),
      completion_tokens: Math.ceil(reply.length / 4),
      total_tokens: 0,
    };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    if (!stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `relay-${seq}`,
          object: "chat.completion",
          created: 0,
          model: body.model ?? modelName,
          choices: [
            { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
          ],
          usage,
        }),
      );
      return;
    }
    const chunk = (delta, finishReason = null, extra = {}) =>
      res.write(
        `data: ${JSON.stringify({ id: `relay-${seq}`, object: "chat.completion.chunk", created: 0, model: body.model ?? modelName, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })}\n\n`,
      );
    for (let i = 0; i < reply.length; i += 40) chunk({ content: reply.slice(i, i + 40) });
    chunk({}, "stop", { usage });
    res.end("data: [DONE]\n\n");
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: bound } = server.address();
      resolve({ url: `http://127.0.0.1:${bound}`, dir, stop: () => server.close() });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const dir = arg("dir");
  if (!dir) {
    process.stderr.write(
      "usage: node e2e/relay-model.mjs --dir <folder> [--port N] [--model-name X] [--clean]\n",
    );
    process.exit(2);
  }
  if (process.argv.includes("--clean")) rmSync(dir, { recursive: true, force: true });
  const relay = await startRelayModel({
    dir,
    port: Number(arg("port", "0")),
    modelName: arg("model-name", "relay"),
  });
  console.log(JSON.stringify({ url: relay.url, dir }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(0));
}
