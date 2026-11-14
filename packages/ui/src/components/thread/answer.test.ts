import { describe, expect, it } from "vitest";
import { type AnswerCitation, splitAnswer } from "./answer.js";

const cite = (n: number, at: number): AnswerCitation => ({
  n,
  at,
  status: "ok",
  documentName: "Lease.pdf",
  page: 2,
  quote: "rent monthly",
});

describe("splitAnswer", () => {
  it("places markers at their offsets", () => {
    const parts = splitAnswer("Rent is monthly. Interest is 4%.", [cite(1, 16), cite(2, 32)]);
    expect(parts.map((p) => p.kind)).toEqual(["text", "citation", "text", "citation"]);
    expect(parts[0]).toEqual({ kind: "text", text: "Rent is monthly.", ungrounded: false });
  });

  it("turns placeholders into pending markers until the citation arrives", () => {
    const parts = splitAnswer("Rent is monthly.[[c:1]] More[[c:2]]", [cite(1, 0)]);
    expect(parts).toEqual([
      { kind: "text", text: "Rent is monthly.", ungrounded: false },
      { kind: "citation", citation: cite(1, 0) },
      { kind: "text", text: " More", ungrounded: false },
      { kind: "pending", n: 2 },
    ]);
  });

  it("shows a source cited twice as two markers", () => {
    const parts = splitAnswer("A.[[c:1]] B.[[c:1]]", [cite(1, 0)]);
    expect(parts.filter((p) => p.kind === "citation")).toHaveLength(2);
    expect(parts.some((p) => p.kind === "pending")).toBe(false);
  });

  it("keeps a repeated pending placeholder pending at both spots", () => {
    const parts = splitAnswer("A.[[c:3]] B.[[c:3]]", []);
    expect(parts.filter((p) => p.kind === "pending")).toHaveLength(2);
  });

  it("flags ungrounded ranges", () => {
    const parts = splitAnswer("Grounded. Made up.", [cite(1, 9)], [[10, 18]]);
    expect(parts).toEqual([
      { kind: "text", text: "Grounded.", ungrounded: false },
      { kind: "citation", citation: cite(1, 9) },
      { kind: "text", text: " ", ungrounded: false },
      { kind: "text", text: "Made up.", ungrounded: true },
    ]);
  });

  it("clamps offsets past the end", () => {
    expect(splitAnswer("Hi", [cite(1, 99)]).at(-1)).toEqual({
      kind: "citation",
      citation: cite(1, 99),
    });
  });

  it("returns nothing for empty text", () => {
    expect(splitAnswer("", [])).toEqual([]);
  });
});
