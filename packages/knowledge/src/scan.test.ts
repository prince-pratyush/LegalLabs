import { describe, expect, it } from "vitest";
import { createScanners, type ScanCursor } from "./scan.js";
import { fakeHttp } from "./testing.js";

// Synthetic answers, shaped like each source's published API and never fetched from it.

const FR = "https://www.federalregister.gov/api/v1/documents.json";
const ECFR = "https://www.ecfr.gov/api/versioner/v1";
const UK = "https://www.legislation.gov.uk/new/data.feed";

const scan = (
  source: "fr" | "ecfr" | "uk_legislation",
  routes: Record<string, unknown>,
  cursor: ScanCursor,
  seen: string[] = [],
) => createScanners({ http: () => fakeHttp(routes, seen) })[source](cursor);

const frDoc = (n: number, more: object = {}) => ({
  document_number: `2026-0000${n}`,
  title: `Widget rule ${n}`,
  type: "Rule",
  abstract: "Every widget must carry a label.",
  publication_date: `2026-03-0${n}`,
  html_url: `https://www.federalregister.gov/documents/2026/03/0${n}/2026-0000${n}/widget`,
  ...more,
});

describe("Federal Register scan", () => {
  it("asks only for what was published since the cursor and pages through it", async () => {
    const seen: string[] = [];
    const first = await scan(
      "fr",
      { [FR]: { total_pages: 2, results: [frDoc(1), frDoc(2)] } },
      { since: "2026-03-01" },
      seen,
    );
    const query = new URL(seen[0] ?? "").searchParams;
    expect(query.get("conditions[publication_date][gte]")).toBe("2026-03-01");
    expect(query.get("order")).toBe("oldest");
    expect(first.items[0]).toEqual({
      externalId: "2026-00001",
      url: "https://www.federalregister.gov/documents/2026/03/01/2026-00001/widget",
      title: "Widget rule 1",
      summary: "Every widget must carry a label.",
      docType: "rule",
      publishedOn: "2026-03-01",
    });
    expect(first.cursor).toEqual({ since: "2026-03-01", page: 2 });
    const last = await scan("fr", { [FR]: { total_pages: 2, results: [frDoc(3)] } }, first.cursor);
    expect(last.cursor).toEqual({ since: "2026-03-03" });
  });

  it("keeps the cursor when nothing is new, and never links off the site", async () => {
    const none = await scan("fr", { [FR]: { count: 0 } }, { since: "2026-03-05" });
    expect(none).toEqual({ items: [], cursor: { since: "2026-03-05" } });
    const odd = await scan(
      "fr",
      { [FR]: { total_pages: 1, results: [frDoc(1, { html_url: "http://evil.test/x" })] } },
      { since: "2026-03-01" },
    );
    expect(odd.items[0]?.url).toBe("https://www.federalregister.gov/d/2026-00001");
  });

  it("leaves out an entry it cannot trust", async () => {
    const found = await scan(
      "fr",
      { [FR]: { total_pages: 1, results: [frDoc(1, { document_number: "../x" }), frDoc(2)] } },
      { since: "2026-03-01" },
    );
    expect(found.items.map((i) => i.externalId)).toEqual(["2026-00002"]);
  });

  it("leaves out what could not be stored, and never cuts a character in half", async () => {
    const found = await scan(
      "fr",
      {
        [FR]: {
          total_pages: 1,
          results: [
            frDoc(1, { title: "   " }),
            frDoc(2, { publication_date: "2026-02-31" }),
            frDoc(3, { title: `${"a".repeat(999)}\u{1F600}` }),
          ],
        },
      },
      { since: "2026-03-01" },
    );
    expect(found.items.map((i) => i.title)).toEqual([`${"a".repeat(999)}\ufffd`]);
  });

  it("fails on an answer that is not the API's", async () => {
    await expect(scan("fr", { [FR]: "<html>" }, { since: "2026-03-01" })).rejects.toThrow();
  });
});

const version = (identifier: string, issue: string, more: object = {}) => ({
  identifier,
  name: `§ ${identifier} Labels.`,
  type: "section",
  issue_date: issue,
  substantive: true,
  removed: false,
  ...more,
});

describe("eCFR scan", () => {
  const routes = {
    [`${ECFR}/titles.json`]: {
      titles: [
        { number: 16, latest_amended_on: "2026-03-04" },
        { number: 17, latest_amended_on: "2026-01-01" },
        { number: 35, latest_amended_on: null },
      ],
    },
    [`${ECFR}/versions/title-16.json`]: {
      content_versions: [
        version("305.2", "2026-03-04"),
        version("305.1", "2026-03-02", { removed: true }),
        version("305.3", "2026-03-03", { substantive: false }),
        version("../x", "2026-03-03"),
        version("Subpart A", "2026-03-03", { type: "appendix" }),
      ],
    },
  };

  it("lists amended sections of the titles that changed, oldest first", async () => {
    const seen: string[] = [];
    const found = await scan("ecfr", routes, { since: "2026-03-01" }, seen);
    expect(seen.filter((url) => url.includes("title-17"))).toEqual([]);
    expect(found.items.map((i) => [i.externalId, i.publishedOn, i.summary])).toEqual([
      [
        "16/305.1@2026-03-02",
        "2026-03-02",
        "Section removed from the Code of Federal Regulations.",
      ],
      ["16/305.2@2026-03-04", "2026-03-04", "Section amended."],
    ]);
    expect(found.items[1]).toMatchObject({
      title: "16 CFR § 305.2 Labels.",
      url: "https://www.ecfr.gov/on/2026-03-04/title-16/section-305.2",
      docType: "regulation",
    });
    expect(found.cursor).toEqual({ since: "2026-03-04" });
  });

  it("takes a hundred at a time without skipping any", async () => {
    const many = {
      ...routes,
      [`${ECFR}/versions/title-16.json`]: {
        content_versions: Array.from({ length: 130 }, (_, i) =>
          version(`305.${i + 100}`, "2026-03-02"),
        ),
      },
    };
    const first = await scan("ecfr", many, { since: "2026-03-01" });
    expect(first.items).toHaveLength(100);
    const rest = await scan("ecfr", many, first.cursor);
    expect(rest.items).toHaveLength(30);
    expect(new Set([...first.items, ...rest.items].map((i) => i.url)).size).toBe(130);
    expect(rest.cursor).toEqual({ since: "2026-03-02" });
  });
});

const entry = (id: string, published: string, title = "The Widget Regulations 2026") =>
  `<entry><id>http://www.legislation.gov.uk/id/${id}</id><title>${title}</title>
   <published>${published}T00:00:00Z</published><updated>${published}T09:00:00Z</updated>
   <summary>Rules about widgets.</summary></entry>`;
const feed = (entries: string, next = false) =>
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
   ${next ? '<link rel="next" href="https://evil.test/next"/>' : ""}${entries}</feed>`;

describe("UK legislation scan", () => {
  it("reads the new legislation feed back to the cursor, and follows no address in it", async () => {
    const seen: string[] = [];
    const found = await scan(
      "uk_legislation",
      {
        [`${UK}?page=1`]: feed(
          entry("uksi/2026/7", "2026-03-09") + entry("mystery/2026/1", "2026-03-08"),
          true,
        ),
        [`${UK}?page=2`]: feed(entry("ukpga/2026/2", "2026-02-01"), true),
      },
      { since: "2026-03-01" },
      seen,
    );
    expect(seen).toEqual([`${UK}?page=1`, `${UK}?page=2`]);
    expect(found.items).toEqual([
      {
        externalId: "uksi/2026/7",
        url: "https://www.legislation.gov.uk/uksi/2026/7",
        title: "The Widget Regulations 2026",
        summary: "Rules about widgets.",
        docType: "statutory_instrument",
        publishedOn: "2026-03-09",
      },
    ]);
    expect(found.cursor).toEqual({ since: "2026-03-09" });
  });

  it("refuses a feed with a document type", async () => {
    await expect(
      scan(
        "uk_legislation",
        { [UK]: '<!DOCTYPE feed [<!ENTITY a "b">]><feed/>' },
        { since: "2026-03-01" },
      ),
    ).rejects.toThrow();
  });
});
