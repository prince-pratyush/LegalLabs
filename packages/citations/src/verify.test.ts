import { describe, expect, it } from "vitest";
import { type Sources, verifyCitation } from "./index.js";

const sources = (pages: Record<string, string>): Sources => ({
  documentPage: async (id, page) => pages[`${id}:${page}`] ?? null,
});

const onPage = (text: string, quote: string) =>
  verifyCitation(
    { kind: "document", documentVersionId: "dv_1", page: 1, quote },
    sources({ "dv_1:1": text }),
  );

describe("document citations", () => {
  it("verifies an exact quote at its position on the page", async () => {
    const result = await onPage(
      "Clause 9. The Supplier's aggregate liability is capped.",
      "aggregate liability is capped",
    );
    expect(result).toEqual({
      status: "ok",
      located: { from: 25, to: 54, text: "aggregate liability is capped", exact: true },
    });
  });

  it("flags a quote that is not on the page", async () => {
    const result = await onPage("Clause 9. Payment is due in full.", "aggregate liability");
    expect(result).toEqual({ status: "mismatch", reason: "quote_not_found" });
  });

  it("ignores whitespace differences and reports original offsets", async () => {
    const result = await onPage("Clause 9.  The\n  Supplier shall pay.", "The Supplier shall pay");
    expect(result).toEqual({
      status: "ok",
      located: { from: 11, to: 35, text: "The\n  Supplier shall pay", exact: true },
    });
  });

  it("treats typographic variants as the same text", async () => {
    const page = "The Supplier’s ofﬁce lia­bility";
    expect(await onPage(page, "The Supplier's office liability")).toEqual({
      status: "ok",
      located: { from: 0, to: 31, text: page, exact: true },
    });
  });

  it("matches composed and decomposed accents", async () => {
    const page = "café terms of sale";
    expect(await onPage(page, "café terms of sale")).toMatchObject({
      status: "ok",
      located: { from: 0, to: 19 },
    });
  });

  it("rejoins a word split across a line break", async () => {
    const page = "aggregate lia-\nbility is capped";
    expect(await onPage(page, "aggregate liability is capped")).toMatchObject({
      status: "ok",
      located: { from: 0, to: 31, exact: true },
    });
  });

  it("keeps a real hyphen that falls at a line break", async () => {
    expect(await onPage("a cost-\nbenefit analysis", "cost-benefit analysis")).toMatchObject({
      status: "ok",
      located: { from: 2, to: 24 },
    });
  });

  it("flags a quote under twelve characters without searching", async () => {
    expect(await onPage("Payment is due.", "Payment is")).toEqual({
      status: "mismatch",
      reason: "quote_too_short",
    });
  });

  it("cannot resolve a page that does not exist", async () => {
    const result = await verifyCitation(
      { kind: "document", documentVersionId: "dv_9", page: 3, quote: "aggregate liability" },
      sources({}),
    );
    expect(result).toEqual({ status: "unresolved", reason: "page_not_found" });
  });
});
