import { describe, expect, it } from "vitest";
import { diffList, diffWords } from "./index.js";

const apply = (ops: ReturnType<typeof diffWords>, side: "before" | "after") =>
  ops
    .filter((o) => o.op === "equal" || o.op === (side === "before" ? "delete" : "insert"))
    .map((o) => o.text)
    .join("");

describe("diffWords", () => {
  it("marks only the words that changed", () => {
    const ops = diffWords("Review the NDA for risks.", "Review the MSA for risks.");
    expect(ops).toEqual([
      { op: "equal", text: "Review the " },
      { op: "delete", text: "NDA" },
      { op: "insert", text: "MSA" },
      { op: "equal", text: " for risks." },
    ]);
  });

  it("rebuilds both sides from the ops", () => {
    const before = "One two three\nfour five six seven";
    const after = "One 2 three\nfour six seven eight";
    const ops = diffWords(before, after);
    expect(apply(ops, "before")).toBe(before);
    expect(apply(ops, "after")).toBe(after);
  });

  it("gives the same answer every time", () => {
    const a = "alpha beta gamma delta";
    const b = "alpha gamma beta delta";
    expect(diffWords(a, b)).toEqual(diffWords(a, b));
  });

  it("handles empty sides and identical text", () => {
    expect(diffWords("", "new text")).toEqual([{ op: "insert", text: "new text" }]);
    expect(diffWords("old", "")).toEqual([{ op: "delete", text: "old" }]);
    expect(diffWords("same", "same")).toEqual([{ op: "equal", text: "same" }]);
    expect(diffWords("", "")).toEqual([]);
  });

  it("copes with long instructions", () => {
    const words = Array.from({ length: 3000 }, (_, i) => `w${i}`);
    const changed = [...words];
    changed[1500] = "changed";
    const ops = diffWords(words.join(" "), changed.join(" "));
    expect(apply(ops, "after")).toBe(changed.join(" "));
    expect(ops.filter((o) => o.op !== "equal")).toHaveLength(2);
  });
});

describe("diffList", () => {
  it("lists additions and removals by key", () => {
    const change = diffList([{ l: "a" }, { l: "b" }], [{ l: "b" }, { l: "c" }], (i) => i.l);
    expect(change).toEqual({ added: [{ l: "c" }], removed: [{ l: "a" }] });
  });
});
