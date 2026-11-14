import { describe, expect, it } from "vitest";
import { chunkText, htmlToText, splitSections } from "./text.js";

describe("htmlToText", () => {
  it("keeps the words and the line breaks, and drops scripts and styles", () => {
    const html =
      "<head><title>t</title></head><style>p{}</style><script>alert(1)</script>" +
      "<p class='oj-normal'>First&nbsp;line &amp; more</p><div>Second <b>bold</b></div>";
    expect(htmlToText(html)).toBe("First line & more\nSecond bold");
  });

  it("decodes numeric entities", () => {
    expect(htmlToText("<p>&#167; 2 &#x2014; x</p>")).toBe("§ 2 — x");
  });
});

describe("chunkText", () => {
  it("packs whole paragraphs up to the size", () => {
    const chunks = chunkText("aaaa\nbbbb\ncccc", "S", 9);
    expect(chunks).toEqual([
      { sectionPath: "S", text: "aaaa\nbbbb" },
      { sectionPath: "S", text: "cccc" },
    ]);
  });

  it("cuts a long paragraph at word breaks without losing words", () => {
    const words = Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ");
    const chunks = chunkText(words, null, 40);
    expect(chunks.every((c) => c.text.length <= 40)).toBe(true);
    expect(chunks.map((c) => c.text.trim()).join(" ")).toBe(words);
  });

  it("gives nothing for blank text", () => {
    expect(chunkText(" \n\n ", null)).toEqual([]);
  });
});

describe("splitSections", () => {
  it("starts a section at each heading line", () => {
    const text = "Recital one\nArticle 1\nScope text\nArticle 2a\nMore";
    expect(splitSections(text, /^(Article \d+[a-z]?)$/, "Preamble")).toEqual([
      { title: "Preamble", body: "Recital one" },
      { title: "Article 1", body: "Article 1\nScope text" },
      { title: "Article 2a", body: "Article 2a\nMore" },
    ]);
  });
});
