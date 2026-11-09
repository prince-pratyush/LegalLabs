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

  it("cannot resolve a page that does not exist", async () => {
    const result = await verifyCitation(
      { kind: "document", documentVersionId: "dv_9", page: 3, quote: "aggregate liability" },
      sources({}),
    );
    expect(result).toEqual({ status: "unresolved", reason: "page_not_found" });
  });
});
