import { describe, expect, it } from "vitest";
import { boxesFor } from "./boxes.js";

const line = (from: number, to: number, y: number) => ({
  from,
  to,
  x0: 72,
  y0: y,
  x1: 300,
  y1: y + 12,
});
const blocks = [line(0, 10, 60), line(11, 20, 74), line(22, 30, 102)];

describe("boxesFor", () => {
  it("returns every line a quote touches", () => {
    expect(boxesFor(blocks, 5, 15)).toEqual([line(0, 10, 60), line(11, 20, 74)]);
  });

  it("leaves out a line the quote stops just short of", () => {
    expect(boxesFor(blocks, 0, 10)).toEqual([line(0, 10, 60)]);
    expect(boxesFor(blocks, 20, 22)).toEqual([]);
  });

  it("has nothing to offer for a file with no layout", () => {
    expect(boxesFor([], 0, 100)).toEqual([]);
  });
});
