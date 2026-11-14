import { describe, expect, it } from "vitest";
import { coverageLine } from "./run-progress.js";

describe("coverageLine", () => {
  it("says files, percent and pages", () => {
    expect(
      coverageLine({ docsRead: 312, docsInScope: 1204, pagesRead: 4120, pagesInScope: 18900 }),
    ).toBe("Read 312 of 1,204 files (26%) · 4,120 of 18,900 pages");
  });

  it("is 0% with nothing in scope", () => {
    expect(coverageLine({ docsRead: 0, docsInScope: 0, pagesRead: 0, pagesInScope: 0 })).toBe(
      "Read 0 of 0 files (0%) · 0 of 0 pages",
    );
  });
});
