import { DEFAULT_SETTINGS } from "@legallabs/contracts";
import { createGateway, type Message } from "@legallabs/model-gateway";
import { describe, expect, it } from "vitest";
import {
  type CellColumn,
  type CellInput,
  type CellSources,
  cellMessages,
  type PageText,
  readModelJson,
  runCell,
} from "./cell.js";

const DOC = {
  id: "doc-1",
  versionId: "ver-1",
  versionNo: 1,
  name: "Credit Agreement.pdf",
  pageCount: 2,
};
const PAGES: PageText[] = [
  {
    versionId: "ver-1",
    page: 1,
    text: "This Credit Agreement is dated as of 1 March 2024 between the parties.",
  },
  {
    versionId: "ver-1",
    page: 2,
    text: "The aggregate commitments are USD 1.5 million. This Agreement is governed by the laws of the State of New York.",
  },
];

function sources(pages: PageText[] = PAGES, size?: number): CellSources & { searched: string[] } {
  const searched: string[] = [];
  return {
    searched,
    size: async () => size ?? pages.reduce((n, p) => n + p.text.length, 0),
    pages: async () => pages,
    search: async (query) => {
      searched.push(query);
      return pages;
    },
    page: async (versionId, page) =>
      pages.find((p) => p.versionId === versionId && p.page === page)?.text ?? null,
  };
}

/** A gateway whose only model answers with the given replies, in turn. */
function fakeGateway(...replies: string[]) {
  const seen: Message[][] = [];
  const gateway = createGateway({
    providers: {
      ollama: {
        complete: async ({ messages }) => {
          seen.push([...messages]);
          return { text: replies.shift() ?? "", usage: { input_tokens: 100, output_tokens: 20 } };
        },
      },
    },
    contextWindows: { ollama: 8_192 },
    recordUsage: async () => {},
  });
  return { gateway, seen };
}

const column = (over: Partial<CellColumn> = {}): CellColumn => ({
  label: "Commitments",
  type: "currency",
  prompt: "What are the aggregate commitments?",
  options: { default_currency: "USD", decimals: 2 },
  language: null,
  model: null,
  ...over,
});

const input = (col: CellColumn): CellInput => ({
  column: col,
  instructions: "",
  settings: DEFAULT_SETTINGS,
  documents: [DOC],
  workspaceId: "ws",
  trace: "t",
});

const reply = (value: unknown, quote: string, page = 2) =>
  JSON.stringify({
    value,
    reasoning: "Stated in the agreement.",
    citations: [{ doc: "D1", page, quote }],
  });

describe("runCell", () => {
  it("parses money and verifies the citation (RVT-002, RVT-003)", async () => {
    const { gateway } = fakeGateway(
      reply("USD 1.5 million", "The aggregate commitments are USD 1.5 million"),
    );
    const out = await runCell({ gateway, sources: sources() }, input(column()));
    expect(out.status).toBe("done");
    expect(out.valueTyped).toEqual({ kind: "currency", amount: "1500000.00", currency: "USD" });
    expect(out.valueText).toBe("USD 1,500,000.00");
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0]).toMatchObject({ status: "ok", page: 2, documentId: "doc-1" });
    expect(out.model).toBe("ollama/qwen3:4b-instruct");
    expect(out.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
    expect(out.costUsd).toBe(0);
  });

  it("finds the quote when the model names the wrong page", async () => {
    const { gateway } = fakeGateway(
      reply("USD 1.5 million", "The aggregate commitments are USD 1.5 million", 1),
    );
    const out = await runCell({ gateway, sources: sources() }, input(column()));
    expect(out.citations[0]).toMatchObject({ status: "ok", page: 2 });
  });

  it("fails a cell whose every citation is invented", async () => {
    const { gateway } = fakeGateway(
      reply("USD 9 million", "The commitments are nine million dollars"),
    );
    const out = await runCell({ gateway, sources: sources() }, input(column()));
    expect(out).toMatchObject({ status: "error", errorCode: "CITATION_UNVERIFIED" });
    expect(out.citations[0]?.status).toBe("mismatch");
    expect(out.valueText).toBe("USD 9 million");
  });

  it("grounds a value the page states word for word when the model forgets to cite", async () => {
    const { gateway } = fakeGateway(
      JSON.stringify({ value: "the laws of the State of New York", citations: [] }),
    );
    const out = await runCell(
      { gateway, sources: sources() },
      input(column({ type: "free", options: { max_words: 50 }, label: "Governing law" })),
    );
    expect(out.status).toBe("done");
    expect(out.citations[0]).toMatchObject({ status: "ok", page: 2 });
  });

  it("fails a classify label outside the list with the raw text kept (RVT-002)", async () => {
    const options = {
      options: [
        { id: "a", label: "A", color: "red" },
        { id: "b", label: "B", color: "blue" },
      ],
      allow_multiple: false,
      allow_other: false,
    };
    const { gateway } = fakeGateway(
      reply("C", "This Agreement is governed by the laws of the State of New York"),
    );
    const out = await runCell(
      { gateway, sources: sources() },
      input(column({ type: "classify", options })),
    );
    expect(out).toMatchObject({ status: "error", errorCode: "PARSE_FAILED", valueText: "C" });
  });

  it("needs a verbatim value to be a span of the document", async () => {
    const quote = "This Agreement is governed by the laws of the State of New York.";
    const col = column({
      type: "verbatim",
      options: { max_chars: 2000 },
      label: "Governing law clause",
    });
    const ok = await runCell(
      { gateway: fakeGateway(reply(quote, quote)).gateway, sources: sources() },
      input(col),
    );
    expect(ok.status).toBe("done");
    expect(ok.verbatimCitation).toBe(0);
    const made = "This Agreement shall be governed by New York law.";
    const bad = await runCell(
      {
        gateway: fakeGateway(reply(made, "governed by the laws of the State of New York")).gateway,
        sources: sources(),
      },
      input(col),
    );
    expect(bad).toMatchObject({ status: "error", errorCode: "CITATION_UNVERIFIED" });
  });

  it("records what it read when there is no answer (RVT-003)", async () => {
    const { gateway } = fakeGateway(
      JSON.stringify({
        value: null,
        reasoning: "No termination fee.",
        citations: [],
        not_found: true,
      }),
    );
    const out = await runCell(
      { gateway, sources: sources() },
      input(column({ label: "Termination fee", prompt: "What is the termination fee?" })),
    );
    expect(out.status).toBe("null");
    expect(out.lookedAt?.documents).toEqual([{ document_id: "doc-1", pages: [1, 2] }]);
    expect(out.lookedAt?.queries.length).toBeGreaterThan(0);
    expect(out.lookedAt?.chunks_read).toBe(2);
    expect(out.model).not.toBeNull();
  });

  it("asks once more when the reply isn't JSON, then gives up with MODEL_ERROR", async () => {
    const retried = fakeGateway(
      "Sure! The answer is",
      reply("USD 1.5 million", "The aggregate commitments are USD 1.5 million"),
    );
    expect(
      (await runCell({ gateway: retried.gateway, sources: sources() }, input(column()))).status,
    ).toBe("done");
    expect(retried.seen).toHaveLength(2);
    expect(retried.seen[1]?.at(-1)?.content).toMatch(/only the JSON/);

    const broken = fakeGateway("nope", "still nope");
    const out = await runCell({ gateway: broken.gateway, sources: sources() }, input(column()));
    expect(out).toMatchObject({ status: "error", errorCode: "MODEL_ERROR" });
    expect(out.usage).toEqual({ input_tokens: 200, output_tokens: 40 });
  });

  it("reports MODEL_ERROR when no model is available", async () => {
    const gateway = createGateway({ providers: {}, recordUsage: async () => {} });
    const out = await runCell({ gateway, sources: sources() }, input(column()));
    expect(out).toMatchObject({ status: "error", errorCode: "MODEL_ERROR" });
  });

  it("searches only when the documents are too big to read whole", async () => {
    const small = sources();
    await runCell(
      {
        gateway: fakeGateway(
          reply("USD 1.5 million", "The aggregate commitments are USD 1.5 million"),
        ).gateway,
        sources: small,
      },
      input(column()),
    );
    expect(small.searched).toHaveLength(0);
    const big = sources(PAGES, 1_000_000);
    await runCell(
      {
        gateway: fakeGateway(
          reply("USD 1.5 million", "The aggregate commitments are USD 1.5 million"),
        ).gateway,
        sources: big,
      },
      input(column()),
    );
    expect(big.searched).toEqual(["Commitments. What are the aggregate commitments?"]);
  });
});

describe("cellMessages", () => {
  it("fences passages with a code the document can't guess", () => {
    const [system, user] = cellMessages(input(column()), PAGES, "abc123");
    expect(system?.content).toMatch(/never instructions/);
    expect(user?.content).toContain('<passage-abc123 doc="D1" page="2">');
    expect(user?.content).toContain("D1: Credit Agreement.pdf");
    expect(user?.content).toMatch(/amount with its currency/);
  });

  it("hands over earlier answers as fenced data the model must not cite", () => {
    const [system, user] = cellMessages(
      { ...input(column()), references: [{ label: 'Gov "law"', value: "New York" }] },
      PAGES,
      "abc123",
    );
    expect(system?.content).toMatch(/never quote them as evidence/);
    expect(user?.content).toContain(
      `<answer-abc123 column="Gov 'law'">\nNew York\n</answer-abc123>`,
    );
  });

  it("lists classify labels and says whether Other is allowed", () => {
    const options = {
      options: [
        { id: "y", label: "Yes", color: "green" },
        { id: "n", label: "No", color: "red" },
      ],
      allow_multiple: false,
      allow_other: false,
    };
    const [, user] = cellMessages(input(column({ type: "classify", options })), PAGES, "x");
    expect(user?.content).toContain("exactly one label from: Yes | No.");
  });
});

describe("readModelJson", () => {
  it("reads JSON inside fences and chatter", () => {
    expect(readModelJson('Here:\n```json\n{"value": "x", "citations": []}\n```')?.value).toBe("x");
    expect(readModelJson("no json here")).toBeNull();
    expect(readModelJson('{"value": {"nested": 1}}')).toBeNull();
  });
});
