// A stand-in for an OpenAI-compatible model server, so the pilot runs the same
// way on any machine. It answers from the first passage it is shown, quoting it
// exactly, which is what a well-behaved model does.
import { createServer } from "node:http";

const PASSAGE = /<passage-[0-9a-f]+ doc="(D\d+)" page="(\d+)">\n([\s\S]*?)\n<\/passage-/;
const PAGE = /<page-[0-9a-f]+ n="(\d+)">\n([\s\S]*?)\n<\/page-/;
const DRAFT = /<draft-[0-9a-f]+>\n([\s\S]*?)\n<\/draft-/;

const sentence = (text) =>
  (text.match(/[^.!?]+[.!?]/g) ?? [text]).map((s) => s.trim()).find((s) => s.split(/\s+/).length >= 4) ??
  text.trim();
const attr = (text) => text.replaceAll('"', "&quot;");

export function reply(messages) {
  const system = messages[0]?.content ?? "";
  const last = messages.at(-1)?.content ?? "";
  if (system.startsWith("You edit legal drafts")) {
    const body = DRAFT.exec(last)?.[1] ?? "";
    return `${body.replace(/\n## Sources[\s\S]*$/, "")}\n\nThis draft was reviewed for the pilot.`;
  }
  if (system.startsWith("You read one document")) {
    const page = PAGE.exec(last);
    if (!page) return "NONE";
    const quote = sentence(page[2]);
    return `${quote}<c page="${page[1]}" quote="${attr(quote)}"/>`;
  }
  const passage = PASSAGE.exec(last);
  if (!passage) return "I couldn't find this in the selected documents.";
  const quote = sentence(passage[3]);
  return `${quote}<c doc="${passage[1]}" page="${passage[2]}" quote="${attr(quote)}"/>`;
}

export function startFakeModel() {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    const text = reply(body.messages ?? []);
    const usage = { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: Math.ceil(text.length / 4) };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "fake",
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish = null, extra = {}) =>
      res.write(
        `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`,
      );
    for (let i = 0; i < text.length; i += 12) chunk({ content: text.slice(i, i + 12) });
    chunk({}, "stop", { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } });
    res.end("data: [DONE]\n\n");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, stop: () => server.close() });
    });
  });
}
