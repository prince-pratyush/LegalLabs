import { describe, expect, it } from "vitest";
import { type Sources, verifyCitation } from "./index.js";

const sources = (pages: Record<string, string>, more: Partial<Sources> = {}): Sources => ({
  documentPage: async (id, page) => pages[`${id}:${page}`] ?? null,
  webPage: async () => null,
  ...more,
});

const onPage = (text: string, quote: string) =>
  verifyCitation(
    { kind: "document", documentVersionId: "dv_1", page: 1, quote },
    sources({ "dv_1:1": text }),
  );

describe("web citations", () => {
  const url = "https://example.test/terms";

  it("locates the quote in the fetched text", async () => {
    const webPage = async (asked: string) => (asked === url ? "Fees are payable monthly." : null);
    const result = await verifyCitation(
      { kind: "web", url, quote: "Fees are payable" },
      sources({}, { webPage }),
    );
    expect(result).toMatchObject({ status: "ok", located: { from: 0, to: 16 } });
  });

  it("cannot resolve a page that could not be fetched", async () => {
    const result = await verifyCitation(
      { kind: "web", url, quote: "Fees are payable" },
      sources({}),
    );
    expect(result).toEqual({ status: "unresolved", reason: "url_not_fetched" });
  });
});

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

  const quote60 = "The Supplier shall indemnify the Customer against all claims";

  it("tolerates a scan error within 2% of the quote", async () => {
    const page = "The Supplier shall indemnify the Customer agalnst all claims.";
    expect(await onPage(page, quote60)).toEqual({
      status: "ok",
      located: { from: 0, to: 60, text: page.slice(0, 60), exact: false },
    });
  });

  it("flags a quote with more errors than the tolerance allows", async () => {
    const page = "The Supplier shall indemnify the Custcmer agalnst all claims.";
    expect(await onPage(page, quote60)).toEqual({
      status: "mismatch",
      reason: "quote_not_found",
    });
  });

  it("allows no errors in a quote under 50 characters", async () => {
    expect(await onPage("Payment is due in fuIl today.", "Payment is due in full today")).toEqual({
      status: "mismatch",
      reason: "quote_not_found",
    });
  });

  const quote250 =
    "The Supplier shall be liable to the Customer for loss arising from a breach of clause 14, " +
    "and each party shall give written notice of the claim within 30 days after it becomes " +
    "aware of the breach, setting out in reasonable detail the grounds for that claim.";

  it.each([
    ["a dropped negation", quote250.replace("shall be", "shall not be")],
    ["a changed number", quote250.replace("30 days", "60 days")],
    ["a swapped word", quote250.replace("notice", "advice")],
    ["a dropped word", quote250.replace("that claim", "claim")],
  ])("refuses a near match with %s, and shows what it found", async (_, page) => {
    const result = await onPage(page, quote250);
    expect(result).toMatchObject({
      status: "mismatch",
      reason: "meaning_changed",
      closest: { exact: false },
    });
  });

  it.each([
    ["licensor", "licensee"],
    ["employer", "employee"],
  ])("refuses %s read as %s", async (quoted, printed) => {
    const clause = `${quote250} The ${quoted} accepts this.`;
    const page = clause.replace(quoted, printed);
    expect(await onPage(page, clause)).toMatchObject({ reason: "meaning_changed" });
  });

  it("accepts a common scan confusion inside one word", async () => {
    const page = quote250.replace("arising", "anising").replace("clause", "dause");
    expect(await onPage(page, quote250)).toMatchObject({
      status: "ok",
      located: { exact: false },
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
