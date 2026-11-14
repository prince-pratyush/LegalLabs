import { describe, expect, it } from "vitest";
import { type DiffOp, diffKeys, diffWords, summariseChanges } from "./diff.js";

const rebuild = (ops: readonly DiffOp[]) => ({
  before: ops
    .filter((op) => op.op !== "insert")
    .map((op) => op.text)
    .join(""),
  after: ops
    .filter((op) => op.op !== "delete")
    .map((op) => op.text)
    .join(""),
});

// A small seeded generator, so a failing case can be replayed.
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

const VOCAB = [
  "the",
  "Supplier",
  "shall",
  "not",
  "exceed",
  "fees",
  "12",
  "months",
  " ",
  "  ",
  "\n",
  ".",
];

function sentence(next: () => number, length: number) {
  return Array.from({ length }, () => VOCAB[Math.floor(next() * VOCAB.length)]).join(" ");
}

describe("diffWords", () => {
  it("marks a replaced word", () => {
    expect(diffWords("pay within 30 days", "pay within 14 days")).toEqual([
      { op: "equal", text: "pay within " },
      { op: "delete", text: "30" },
      { op: "insert", text: "14" },
      { op: "equal", text: " days" },
    ]);
  });

  it("handles empty sides", () => {
    expect(diffWords("", "")).toEqual([]);
    expect(diffWords("", "new text")).toEqual([{ op: "insert", text: "new text" }]);
    expect(diffWords("old text", "")).toEqual([{ op: "delete", text: "old text" }]);
  });

  it("never puts two ops of the same kind side by side", () => {
    const ops = diffWords("a b c d e", "a x y d z");
    for (let i = 1; i < ops.length; i++) expect(ops[i]?.op).not.toBe(ops[i - 1]?.op);
  });

  it("rebuilds both sides for random edits", () => {
    const next = random(7);
    for (let n = 0; n < 200; n++) {
      const before = sentence(next, Math.floor(next() * 40));
      const after = sentence(next, Math.floor(next() * 40));
      expect(rebuild(diffWords(before, after))).toEqual({ before, after });
    }
  });

  it("stays correct past the table limit by diffing lines", () => {
    const line = (i: number) => `clause ${i} applies to every party here\n`;
    const before = Array.from({ length: 1500 }, (_, i) => line(i)).join("");
    const after = before.replace(line(10), "a changed clause\n").replace(line(1400), "");
    const ops = diffWords(`start ${before}`, `begin ${after}`);
    expect(rebuild(ops)).toEqual({ before: `start ${before}`, after: `begin ${after}` });
  });
});

describe("diffKeys", () => {
  it("counts whole items", () => {
    expect(diffKeys(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual([
      { op: "equal", count: 1 },
      { op: "delete", count: 1 },
      { op: "insert", count: 1 },
      { op: "equal", count: 1 },
      { op: "insert", count: 1 },
    ]);
  });
});

describe("diffKeys with awkward keys", () => {
  it("never splits a key that holds a line break", () => {
    expect(diffKeys(["a\nb", "c\n"], ["a\nb", "x\ny", "c\n"])).toEqual([
      { op: "equal", count: 1 },
      { op: "insert", count: 1 },
      { op: "equal", count: 1 },
    ]);
  });

  it("reports a huge changed middle as replaced, with exact counts", () => {
    const before = ["head", ...Array.from({ length: 2500 }, (_, i) => `old ${i}\n`), "tail"];
    const after = ["head", ...Array.from({ length: 2400 }, (_, i) => `new ${i}\n`), "tail"];
    expect(diffKeys(before, after)).toEqual([
      { op: "equal", count: 1 },
      { op: "delete", count: 2500 },
      { op: "insert", count: 2400 },
      { op: "equal", count: 1 },
    ]);
  });
});

describe("summariseChanges", () => {
  it("counts changes and words", () => {
    expect(
      summariseChanges(diffWords("pay within 30 days", "pay us within 14 business days")),
    ).toEqual({
      insertions: 2,
      deletions: 1,
      insertedWords: 3,
      deletedWords: 1,
    });
  });
});
