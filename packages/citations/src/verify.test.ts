import { describe, expect, it } from "vitest";
import { type Authority, type CitationStatus, type Sources, verifyCitation } from "./index.js";

const sources = (pages: Record<string, string>, more: Partial<Sources> = {}): Sources => ({
  documentPage: async (id, page) => pages[`${id}:${page}`] ?? null,
  webPage: async () => null,
  cellCitationStatuses: async () => null,
  authorityById: async () => null,
  authoritiesByCitation: async () => [],
  authorityPassages: async () => [],
  ...more,
});

const roe: Authority = { id: "courtlistener:opinion:108713" };

const inIndex = (authorities: Record<string, readonly Authority[]>, passages: string[] = []) =>
  sources(
    {},
    {
      authoritiesByCitation: async (normalized) => authorities[normalized] ?? [],
      authorityById: async (id) => (id === roe.id ? roe : null),
      authorityPassages: async () => passages,
    },
  );

const onPage = (text: string, quote: string) =>
  verifyCitation(
    { kind: "document", documentVersionId: "dv_1", page: 1, quote },
    sources({ "dv_1:1": text }),
  );

describe("authority citations", () => {
  const cite = (reference: string, more: { pin?: string; quote?: string } = {}) =>
    ({ kind: "authority", reference, ...more }) as const;

  it("resolves a citation string through the index", async () => {
    const result = await verifyCitation(cite("410 us 113"), inIndex({ "410 us 113": [roe] }));
    expect(result).toEqual({ status: "ok", authorityId: roe.id });
  });

  it("resolves an index id directly", async () => {
    expect(await verifyCitation(cite(roe.id), inIndex({}))).toEqual({
      status: "ok",
      authorityId: roe.id,
    });
  });

  it.each([
    ["410 U.S. 113 (1973)", "410 us 113"],
    ["410 U. S. 113", "410 us 113"],
    ["  410   U.S.\n113 ", "410 us 113"],
    ["123 F. 3d 456", "123 f3d 456"],
    ["123 F.3d 456 (9th Cir. 1999)", "123 f3d 456"],
    ["500 F. Supp. 2d 12", "500 fsupp2d 12"],
    ["17 C.F.R. Sec. 240.10b-5", "17 cfr § 240.10b-5"],
    ["17 CFR section 240.10b-5", "17 cfr § 240.10b-5"],
    ["42 U.S.C. §1983 (2018)", "42 usc § 1983 (2018)"],
  ])("normalises %s before lookup", async (written, normalized) => {
    expect(await verifyCitation(cite(written), inIndex({ [normalized]: [roe] }))).toMatchObject({
      status: "ok",
    });
  });

  it("cannot resolve an unknown citation", async () => {
    expect(await verifyCitation(cite("999 us 999"), inIndex({}))).toEqual({
      status: "unresolved",
      reason: "authority_not_found",
    });
  });

  it("lists the candidates when a citation is ambiguous", async () => {
    const other = { id: "courtlistener:opinion:2" };
    const result = await verifyCitation(
      cite("410 us 113"),
      inIndex({ "410 us 113": [roe, other] }),
    );
    expect(result).toEqual({
      status: "unresolved",
      reason: "ambiguous_authority",
      candidates: [roe.id, other.id],
    });
  });
});

describe("cell citations", () => {
  const withCell = (statuses: readonly CitationStatus[] | null) =>
    verifyCitation(
      { kind: "cell", cellId: "rtc_1" },
      sources({}, { cellCitationStatuses: async () => statuses }),
    );

  it("is ok when every citation in the cell is ok", async () => {
    expect(await withCell(["ok", "ok"])).toEqual({ status: "ok" });
  });

  it("is flagged when any citation in the cell is not ok", async () => {
    expect(await withCell(["ok", "unresolved"])).toEqual({
      status: "mismatch",
      reason: "cell_citation_flagged",
    });
  });

  it("is flagged when the cell has no citations", async () => {
    expect(await withCell([])).toEqual({ status: "mismatch", reason: "cell_has_no_citations" });
  });

  it("cannot resolve a missing cell", async () => {
    expect(await withCell(null)).toEqual({ status: "unresolved", reason: "cell_not_found" });
  });
});

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
