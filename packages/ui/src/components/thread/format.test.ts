import { describe, expect, it } from "vitest";
import { formatCost, formatCount, isLocalModel } from "./format.js";

describe("format", () => {
  it("shows four decimal places", () => expect(formatCost(0.09)).toBe("$0.0900"));
  it("calls a local zero free", () => expect(formatCost(0, true)).toBe("free"));
  it("keeps a paid zero as dollars", () => expect(formatCost(0)).toBe("$0.0000"));
  it("says when cost is unknown", () => expect(formatCost(null)).toBe("cost unknown"));
  it("groups thousands", () => expect(formatCount(12480)).toBe("12,480"));
  it("knows local models", () => {
    expect(isLocalModel("ollama/qwen3:4b-instruct")).toBe(true);
    expect(isLocalModel("anthropic/claude-haiku-5-5")).toBe(false);
    expect(isLocalModel(null)).toBe(false);
  });
});
