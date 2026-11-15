// A stand-in for an OpenAI-compatible model server, so the pilot runs the same
// way on any machine. It answers from the first passage it is shown, quoting it
// exactly, which is what a well-behaved model does.
import { createServer } from "node:http";

const PASSAGE = /<passage-[0-9a-f]+ doc="(D\d+)" page="(\d+)">\n([\s\S]*?)\n<\/passage-/;
const PAGE = /<page-[0-9a-f]+ n="(\d+)">\n([\s\S]*?)\n<\/page-/;
const DRAFT = /<draft-[0-9a-f]+>\n([\s\S]*?)\n<\/draft-/;

const sentence = (text) =>
  (text.match(/[^.!?]+[.!?]/g) ?? [text])
    .map((s) => s.trim())
    .find((s) => s.split(/\s+/).length >= 4) ?? text.trim();
const attr = (text) => text.replaceAll('"', "&quot;");

// Playbook review script: which rule finds what. A rule not listed answers not_found, and
// only the listed gap is reported, so the review comes out the same on every run.
export const PLAYBOOK_SCRIPT = [
  {
    title: "Limitation of Liability Cap",
    para: /liability under this agreement is unlimited/i,
    before: "The Customer's liability under this agreement is unlimited",
    after:
      "Each party's total liability under this agreement is capped at the fees paid in the twelve months before the claim",
    explanation: "Unlimited liability for the customer is unacceptable; a mutual cap is needed.",
  },
  {
    title: "Payment Terms",
    para: /payable within 15 days/i,
    before: "within 15 days of the invoice date",
    after: "within 45 days after receipt of a valid, undisputed invoice",
    explanation: "Payment on less than 30 days is unacceptable.",
  },
];
export const GAP_SCRIPT = {
  para: /coffee beans/i,
  reason: "A ten-year exclusive purchasing commitment that no playbook rule covers.",
};

const numbered = (body, prefix = "") =>
  [...body.matchAll(new RegExp(`^\\[${prefix}(\\d+)\\](?: \\([^)]*\\))? (.*)$`, "gm"))].map(
    (m) => ({ p: Number(m[1]), text: m[2] }),
  );
const docBody = (text) => /<doc-[0-9a-f]+>\n([\s\S]*?)\n<\/doc-/.exec(text)?.[1] ?? "";

function playbookReply(system, last) {
  if (system.startsWith("You sort contract paragraphs into clause types")) {
    const paras = numbered(docBody(last));
    const map = {};
    for (const [, code, title] of last.matchAll(/^(R\d+): (.+?) \(/gm)) {
      const step = PLAYBOOK_SCRIPT.find((s) => s.title === title);
      const hits = step ? paras.filter((x) => step.para.test(x.text)).map((x) => x.p) : [];
      if (hits.length) map[code] = hits;
    }
    return JSON.stringify(map);
  }
  if (system.startsWith("You are a lawyer reviewing a contract")) {
    const title = /^Rule: (.*)$/m.exec(last)?.[1];
    const step = PLAYBOOK_SCRIPT.find((s) => s.title === title);
    const hit = step && numbered(docBody(last)).find((x) => step.para.test(x.text));
    if (!step || !hit) {
      return JSON.stringify({
        status: "not_found",
        evidence: [],
        explanation: "",
        suggestion: null,
      });
    }
    return JSON.stringify({
      status: "not_acceptable",
      matched: "unacceptable",
      fallback: null,
      evidence: [{ p: hit.p, quote: step.before }],
      explanation: step.explanation,
      suggestion: { p: hit.p, before: step.before, after: step.after },
    });
  }
  if (system.startsWith("You check a contract for")) {
    const bodies = [...last.matchAll(/<doc-[0-9a-f]+>\n([\s\S]*?)\n<\/doc-/g)].map((m) => m[1]);
    const hit = numbered(bodies.at(-1) ?? "", "P").find((x) => GAP_SCRIPT.para.test(x.text));
    const gaps = hit
      ? [{ ref: `P${hit.p}`, quote: hit.text, reason: GAP_SCRIPT.reason, severity: "high" }]
      : [];
    return JSON.stringify({ gaps });
  }
  return undefined;
}

// A review-table cell: answers from the first passage, in the column's type.
function cellReply(last) {
  const passage = /<passage-[0-9a-f]+ doc="(D\d+)" page="(\d+)">\n([\s\S]*?)\n<\/passage-/.exec(
    last,
  );
  if (!passage)
    return JSON.stringify({ value: null, reasoning: "", citations: [], not_found: true });
  const text = passage[3];
  const hint = /^The value must be (.*)\.$/m.exec(last)?.[1] ?? "";
  const quoteOf = (re) =>
    (text.match(/[^.!?\n]+[.!?]/g) ?? [])
      .map((s) => s.trim())
      .find((s) => re.test(s) && s.split(/\s+/).length >= 6) ?? sentence(text);
  let value;
  let quote = sentence(text);
  if (hint.startsWith("exactly one label from: ") || hint.startsWith("a JSON list")) {
    const labels = hint
      .replace(/^.*?from: /, "")
      .split(" | ")
      .map((l) => l.replace(/ \(.*$/, "").replace(/, or "Other.*$/, ""));
    const label = labels.find((l) => text.includes(l)) ?? labels[0];
    value = hint.startsWith("a JSON list") ? [label] : label;
    quote = quoteOf(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } else if (hint.startsWith("a number")) {
    const days = /(\d+) days/.exec(text);
    value = days ? `${days[1]} days` : null;
    if (days) quote = quoteOf(/\d+ days/);
  } else {
    value = quote;
  }
  if (value === null)
    return JSON.stringify({ value, reasoning: "", citations: [], not_found: true });
  return JSON.stringify({
    value,
    reasoning: "Taken from the cited passage.",
    citations: [{ doc: passage[1], page: Number(passage[2]), quote }],
    not_found: false,
  });
}

export function reply(messages) {
  const system = messages[0]?.content ?? "";
  const last = messages.at(-1)?.content ?? "";
  const scripted = playbookReply(system, last);
  if (scripted !== undefined) return scripted;
  if (system.startsWith("You fill one cell of a review table")) return cellReply(last);
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
  // Asked to invent, it quotes words that aren't on the page, as a careless model would.
  if (/Question: [^\n]*invent/i.test(last)) {
    return `The cap is unlimited.<c doc="${passage[1]}" page="${passage[2]}" quote="liability is unlimited in every case"/>`;
  }
  const quote = sentence(passage[3]);
  return `${quote}<c doc="${passage[1]}" page="${passage[2]}" quote="${attr(quote)}"/>`;
}

export function startFakeModel() {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    const text = reply(body.messages ?? []);
    const usage = {
      prompt_tokens: Math.ceil(raw.length / 4),
      completion_tokens: Math.ceil(text.length / 4),
    };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "fake",
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [
            { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
          ],
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
    chunk({}, "stop", {
      usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
    });
    res.end("data: [DONE]\n\n");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, stop: () => server.close() });
    });
  });
}
