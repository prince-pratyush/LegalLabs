import { XLSX } from "@legallabs/ingest";
import type { ModelProvider } from "@legallabs/model-gateway";
import { afterAll, describe, expect, it } from "vitest";
import { testPool } from "../test-db.js";
import { matterHarness } from "../test-matters.js";

const pool = testPool();
afterAll(() => pool.end());

// As the document service writes a sheet: its name, then a line per cell.
const PAGE =
  "Fees\n\nA1: Item\nB1: Amount\n\nA2: Rent\nB2: 1200\n\nA3: Rates\nB3: =B2/4 → 300\n\nA4: [[c:9]]\nB4: TBC";

let proposal = "";
let calls: { chooser: boolean; text: string }[] = [];
const model: ModelProvider = {
  complete: async ({ messages }) => {
    const chooser = messages[0]?.content.startsWith("You choose which calculations") === true;
    calls.push({ chooser, text: messages.map((m) => m.content).join("\n") });
    return {
      text: chooser ? proposal : 'The total is 1500.<c doc="D1" page="1" quote="Rent"/>',
      usage: { input_tokens: 400, output_tokens: 50 },
    };
  },
};
const h = matterHarness(pool, { anthropic: model });

async function ask(content: string, computations: unknown, mime = XLSX) {
  proposal = typeof computations === "string" ? computations : JSON.stringify({ computations });
  calls = [];
  const ana = await h.workspace();
  const file = await h.postFile(ana, "/documents", "fees.txt", PAGE);
  await h.drain(ana);
  await pool.query("update content.document set mime = $2 where id = $1", [
    file.body.document.id,
    mime,
  ]);
  const res = await h.call(ana, "POST", "/threads", {
    content,
    scope: { document_ids: [file.body.document.id] },
  });
  await h.threads.threads.settled();
  const thread = (await h.call(ana, "GET", `/threads/${res.body.thread_id}`)).body.thread;
  const events = await h.threads.log.replay(
    { userId: ana.userId, workspaceId: ana.workspaceId } as never,
    res.body.run_id,
    0,
  );
  return { thread, events, answer: thread.messages.at(-1), run: thread.runs[0] };
}

const SUM = [{ doc: "D1", page: 1, op: "sum", range: "B2:B4" }];

describe("computing over a spreadsheet", () => {
  it("does the sum itself, cites each cell with its formula and shows the inputs", async () => {
    const r = await ask("What is the total of the fees?", SUM);
    expect(r.answer.content).toContain("The total is 1500.");
    expect(r.answer.content).toContain(
      "Sum of Fees!B2:B4 in fees.txt: 1500. From Fees!B2 = 1200, Fees!B3 = 300 (=B2/4). Left out, holding no number: B4.",
    );
    const cells = r.answer.citations.filter((c: { cell: string | null }) => c.cell);
    expect(cells).toMatchObject([
      { cell: "Fees!B2", quote: "B2: 1200", status: "ok", n: 2 },
      { cell: "Fees!B3", quote: "B3: =B2/4 → 300", status: "ok", n: 3 },
    ]);
    // Each anchor sits right after the figure it backs.
    expect(r.answer.content.slice(0, cells[0].at).endsWith("Fees!B2 = 1200")).toBe(true);
    expect(cells[1].open_url).toContain("/d/");
    expect(r.events.find((e) => e.type === "step" && e.kind === "tool")).toMatchObject({
      title: "Sum of Fees!B2:B4 in fees.txt = 1500 (B2=1200, B3=300)",
    });
    const live = r.events.flatMap((e) => (e.type === "token" ? [e.delta] : [])).join("");
    expect(live).toContain("Fees!B2 = 1200[[c:2]]");
    expect(calls.at(-1)?.text).toContain("Use the figures exactly");
    expect(r.run.cost_usd).toBeGreaterThan(r.answer.cost_usd);
  });

  it("says nothing was worked out when the choice isn't usable", async () => {
    for (const bad of [
      "I think 1500",
      [{ doc: "D1", page: 1, op: "sum", range: "Other!A1:A9" }],
      [{ doc: "D9", page: 1, op: "sum", range: "B2:B3" }],
    ]) {
      const r = await ask("What is the total?", bad);
      expect(r.answer.content).not.toContain("Calculated by the app");
      expect(calls.at(-1)?.text).toContain("Don't add up");
      expect(r.events.find((e) => e.type === "step" && e.kind === "tool")).toMatchObject({
        status: "failed",
      });
    }
  });

  it("makes no extra call for other questions or other files", async () => {
    await ask("Who pays the rates?", SUM);
    expect(calls.filter((c) => c.chooser)).toHaveLength(0);
    await ask("What is the total?", SUM, "text/plain");
    expect(calls.filter((c) => c.chooser)).toHaveLength(0);
  });
});
