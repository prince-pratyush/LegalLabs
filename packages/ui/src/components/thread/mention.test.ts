import { describe, expect, it } from "vitest";
import { insertMention, matchMentions, mentionQuery } from "./mention.js";

describe("mentionQuery", () => {
  it("finds the word after @", () => {
    expect(mentionQuery("ask @ms", 7)).toEqual({ query: "ms", start: 4 });
  });

  it("opens on a bare @ at the start", () => {
    expect(mentionQuery("@", 1)).toEqual({ query: "", start: 0 });
  });

  it("ignores an @ inside a word", () => {
    expect(mentionQuery("mail ana@firm", 13)).toBeNull();
  });

  it("closes after a line break", () => {
    expect(mentionQuery("@a\nb", 4)).toBeNull();
  });

  it("only reads up to the caret", () => {
    expect(mentionQuery("@abc def", 3)).toEqual({ query: "ab", start: 0 });
  });

  it("ignores an @ followed by a space", () => {
    expect(mentionQuery("meet @ 5pm", 10)).toBeNull();
    expect(mentionQuery("meet @ ", 7)).toBeNull();
  });

  it("returns null with no @", () => {
    expect(mentionQuery("hello", 5)).toBeNull();
  });
});

describe("matchMentions", () => {
  const items = [
    { type: "document" as const, id: "1", label: "Lease.pdf" },
    { type: "vault" as const, id: "2", label: "Falcon lease pack" },
    { type: "source" as const, id: "3", label: "EDGAR" },
  ];

  it("puts prefix matches first", () => {
    expect(matchMentions(items, "lea").map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("matches everything on an empty query", () => {
    expect(matchMentions(items, "")).toHaveLength(3);
  });
});

describe("insertMention", () => {
  it("replaces the query and moves the caret after it", () => {
    expect(insertMention("see @le now", 4, 7, "Lease.pdf")).toEqual({
      text: "see @Lease.pdf  now",
      caret: 15,
    });
  });
});
