import { describe, expect, it } from "vitest";
import { applyHunks, hunks } from "./hunks.js";

const roundTrip = (before: string, after: string) => {
  const list = hunks(before, after);
  expect(applyHunks(before, list)).toBe(after);
  return list;
};

describe("hunks", () => {
  it("changes only the words that differ", () => {
    const list = roundTrip(
      "continue for a period of ten (10) years from the date",
      "continue for a period of three (3) years from the date",
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ insert: "three (3)", occurrence: 0 });
  });

  it("gives a pure insertion the word before it, so Word has text to find", () => {
    const list = roundTrip("The Recipient shall exceed", "The Recipient shall not exceed");
    expect(list).toEqual([{ from: 14, to: 20, insert: "shall not ", occurrence: 0 }]);
  });

  it("takes the next word when an insertion comes first", () => {
    const list = roundTrip("Agreement applies", "This Agreement applies");
    expect(list[0]).toMatchObject({ from: 0, insert: "This Agreement" });
  });

  it("counts earlier matches, so a repeated word is edited in the right place", () => {
    const list = roundTrip("the Recipient and the Discloser", "the Recipient and a Discloser");
    expect(list).toEqual([{ from: 18, to: 21, insert: "a", occurrence: 1 }]);
  });

  it("handles deletions and several separate edits", () => {
    const list = roundTrip(
      "must keep it secret and must not disclose it to anyone at all",
      "must keep it confidential and must not disclose it to anyone",
    );
    expect(list).toHaveLength(2);
  });

  it("returns nothing when the text is unchanged", () => {
    expect(hunks("same text", "same text")).toEqual([]);
  });
});
